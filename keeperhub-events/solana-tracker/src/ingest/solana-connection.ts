import {
  type Commitment,
  type ConfirmedSignatureInfo,
  Connection,
  type Finality,
  type GetVersionedBlockConfig,
  PublicKey,
  type SignaturesForAddressOptions,
  type VersionedBlockResponse,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { logger } from "../../lib/utils/logger";
import { redactRpcUrl, redactUrlsInText } from "../../lib/utils/redact-url";
import { formatError } from "../format-error";

/**
 * Per-chain Solana connection: a web3.js Connection providing both the WS
 * `slotSubscribe` tick and the HTTP `getBlock`/`getBlocks` reads, with a
 * slot-staleness watchdog that rebuilds the connection and rotates
 * primary<->fallback endpoints when the slot stream stalls (the analog of the
 * EVM block-dispatcher's no-block-advance reconnect).
 *
 * The health model here was reshaped after the 2026-09-09 incident. The old
 * one derived `connected`
 * from `slotSubId !== null && !reconnecting`, and stamped `lastSlotAt` at
 * subscribe time. Both lie: `onSlotChange` hands back a subscription id before
 * the socket has opened, let alone delivered anything, so a dead endpoint read
 * healthy for a full staleness window. On 2026-09-09 that combination let a
 * silent devnet route report healthy, then flip the whole process to 503 and
 * take Solana mainnet ingestion down with it. What is recorded now is what
 * actually happened - a slot arrived, or it did not.
 */

const SLOT_STALENESS_CHECK_MS = 15_000;
const SLOT_STALENESS_TIMEOUT_MS = 60_000;

/**
 * How long a brand-new subscription may deliver nothing before we rotate.
 *
 * Deliberately far below SLOT_STALENESS_TIMEOUT_MS, and the asymmetry is the
 * point: being wrong about "never delivered" costs one resubscribe, while being
 * wrong about a live stream costs dropped slots. Measured cadence on our own
 * endpoints is ~325ms between notifications on mainnet and ~165ms on devnet, so
 * a working endpoint delivers inside a second; 20s is over 60x that and clears
 * any plausible DNS + TLS + WS-upgrade handshake. The watchdog samples every
 * 15s, so the observed rotation lands at ~30s - say the effective number, not
 * the nominal one, when reading logs.
 */
const FIRST_SLOT_GRACE_MS = 20_000;

/**
 * Cap on the unsubscribe round-trip during a reconnect.
 *
 * This is the 2026-09-09 wedge. `removeSlotChangeListener` on a half-open
 * socket never settled: the reconnect logged at 10:29:14.773Z and the follow-up
 * subscribe line never appeared before SIGTERM at 10:30:43Z - 88s pinned inside
 * one await, against a 3x30s liveness budget. The surviving container returned
 * from the same call in 3ms.
 *
 * Must stay strictly below SLOT_STALENESS_CHECK_MS so a hung teardown still
 * completes inside one watchdog period; otherwise the watchdog keeps sampling,
 * keeps seeing a reconnect in flight, and we have rebuilt a slower version of
 * the same wedge.
 */
const REMOVE_SUB_TIMEOUT_MS = 5_000;

export interface Endpoint {
  rpcUrl: string;
  wssUrl: string;
}

/**
 * Which ingestion strategy produced a health entry. Shown on /healthz for
 * diagnosis, and deliberately not a metric label: a composite chain reports
 * whichever member ranks worst, so the value changes over time. "none" means
 * no source is running for the chain yet.
 */
export type ConnectionSource =
  | "getblock"
  | "signatures"
  | "geyser"
  | "composite"
  | "none";

/**
 * `stale` is never stored, only derived: the watchdog samples every 15s, so a
 * stored flag would be wrong for up to 75s after a stream actually died, and a
 * metrics scrape landing in that window would read `live`.
 */
export type ConnectionState =
  | "idle"
  | "subscribing"
  | "live"
  | "stale"
  | "reconnecting"
  | "failed"
  | "unimplemented";

export interface ConnectionHealth {
  chainId: number;
  source: ConnectionSource;
  connected: boolean;
  state: ConnectionState;
  reconnecting: boolean;
  /** Set ONLY by a real slot notification. Never by subscribing. */
  lastSlotAt: number | null;
  /** When the current subscription was opened. Resets on every resubscribe. */
  subscribedAt: number | null;
  /** Redacted - this value is served on /healthz. Never log or label the raw URL. */
  activeEndpoint: string;
  endpointIndex: number;
  endpointCount: number;
  reconnects: number;
  abandonedSubscriptions: number;
  lastError: string | null;
}

function toFinality(commitment: Commitment): Finality {
  return commitment === "finalized" ? "finalized" : "confirmed";
}

/**
 * The web3.js internals closeAbandonedConnection() reaches into. Private API,
 * verified against web3.js 1.98.4 and rpc-websockets 9.3.9. If an upgrade
 * changes this shape the helper logs and does nothing, and the socket leak it
 * prevents comes back - so re-check it when upgrading either package.
 */
interface ConnectionInternals {
  _subscriptionsByHash?: Record<string, unknown>;
  _rpcWebSocket?: {
    setAutoReconnect?: (reconnect: boolean) => void;
    close?: (code?: number) => void;
  };
}

/**
 * Close the socket of a connection whose unsubscribe we gave up on.
 *
 * web3.js awaits the unsubscribe call while the subscription stays in
 * `_subscriptionsByHash`, and only idle-closes the socket once that map is
 * empty, so an abandoned removal keeps its socket open for good. Closing the
 * socket is not enough on its own: on a code-1000 close web3.js re-runs
 * `_updateSubscriptions()`, which calls `connect()` again while any entry is
 * left. So the map is replaced first. Auto-reconnect is switched off too,
 * because a half-open socket can end in a non-1000 close, and rpc-websockets
 * reconnects those with no limit.
 */
function closeAbandonedConnection(
  connection: Connection,
  chainId: number,
): void {
  const internals = connection as unknown as ConnectionInternals;
  const socket = internals._rpcWebSocket;
  if (
    !(
      socket?.close &&
      socket.setAutoReconnect &&
      internals._subscriptionsByHash
    )
  ) {
    logger.warn(
      `[solana-conn] chain ${chainId} cannot close an abandoned connection: web3.js internals changed, so its socket will stay open`,
    );
    return;
  }
  try {
    socket.setAutoReconnect(false);
    internals._subscriptionsByHash = {};
    socket.close(1000);
  } catch (err) {
    logger.warn(
      `[solana-conn] chain ${chainId} closing an abandoned connection failed: ${formatError(err)}`,
    );
  }
}

export class SolanaConnection {
  private connection: Connection | null = null;
  private slotSubId: number | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private activeIndex = 0;
  private lastSlotAt: number | null = null;
  private subscribedAt: number | null = null;
  private lastError: string | null = null;
  private stopped = false;
  private phase: Exclude<ConnectionState, "stale"> = "idle";
  private reconnects = 0;
  private abandonedSubscriptions = 0;
  /**
   * Bumped on every subscribe and on stop. A slot callback whose captured epoch
   * no longer matches belongs to a subscription we abandoned, and must be
   * ignored - see removeSub() for why abandoned subscriptions exist at all.
   */
  private epoch = 0;

  constructor(
    private readonly opts: {
      chainId: number;
      source: ConnectionSource;
      endpoints: Endpoint[];
      commitment: Commitment;
      onSlot: (slot: number) => void;
    },
  ) {}

  start(): void {
    this.stopped = false;
    this.openAndSubscribe();
    if (!this.watchdog) {
      this.watchdog = setInterval(
        () => this.checkStaleness(),
        SLOT_STALENESS_CHECK_MS,
      );
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Before the await: nothing from an in-flight subscription may fire once
    // stop() has been called.
    this.epoch += 1;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    await this.removeSub();
    this.connection = null;
    // After the await, so a reconnect that completes mid-teardown cannot leave
    // "subscribing" behind on a stopped object.
    this.phase = "idle";
    this.subscribedAt = null;
    this.lastSlotAt = null;
    this.activeIndex = 0;
    // lastError is deliberately kept: state "idle" already says nothing is
    // running, and the last error is the diagnostic worth reading on /healthz.
  }

  private getConnection(): Connection {
    if (!this.connection) {
      const endpoint = this.opts.endpoints[this.activeIndex];
      this.connection = new Connection(endpoint.rpcUrl, {
        wsEndpoint: endpoint.wssUrl,
        commitment: this.opts.commitment,
      });
    }
    return this.connection;
  }

  private openAndSubscribe(): void {
    if (this.stopped) {
      return;
    }
    const endpoint = this.opts.endpoints[this.activeIndex];
    if (!endpoint) {
      // The old code indexed this unguarded and threw a TypeError that the
      // try/catch below turned into a meaningless lastError.
      this.phase = "failed";
      this.lastError = "no endpoints configured";
      logger.error(
        `[solana-conn] chain ${this.opts.chainId} has no endpoints; nothing to subscribe to`,
      );
      return;
    }
    const epoch = ++this.epoch;
    // Set before registering: if a transport ever delivered synchronously
    // during registration, setting it afterwards would stomp "live" back down.
    this.phase = "subscribing";
    this.subscribedAt = Date.now();
    try {
      const connection = this.getConnection();
      this.slotSubId = connection.onSlotChange((info) => {
        if (this.stopped || epoch !== this.epoch) {
          return;
        }
        this.lastSlotAt = Date.now();
        this.lastError = null;
        this.phase = "live";
        this.opts.onSlot(info.slot);
      });
      logger.log(
        `[solana-conn] chain ${this.opts.chainId} slot subscription on ${redactRpcUrl(endpoint.wssUrl)} (endpoint ${this.activeIndex + 1}/${this.opts.endpoints.length})`,
      );
    } catch (err) {
      // Message only, URLs redacted: lastError is served on /healthz, node-fetch
      // puts the full request URL into its error messages, and chain-config
      // carries the provider key in that URL. The log line below keeps the full
      // detail for triage.
      this.lastError = redactUrlsInText(
        err instanceof Error ? err.message : String(err),
      );
      this.slotSubId = null;
      this.subscribedAt = null;
      // Every exit path writes phase. The old catch left `reconnecting` true
      // forever, and checkStaleness() skipped any chain in that state, so a
      // subscribe that threw was never retried for the life of the pod.
      this.phase = "failed";
      logger.warn(
        `[solana-conn] chain ${this.opts.chainId} subscribe failed: ${formatError(err)}`,
      );
    }
  }

  private currentState(): ConnectionState {
    if (this.phase !== "live") {
      return this.phase;
    }
    if (this.lastSlotAt === null) {
      return "subscribing";
    }
    return Date.now() - this.lastSlotAt > SLOT_STALENESS_TIMEOUT_MS
      ? "stale"
      : "live";
  }

  private checkStaleness(): void {
    if (
      this.stopped ||
      this.phase === "reconnecting" ||
      this.phase === "idle"
    ) {
      return;
    }
    const now = Date.now();
    if (this.phase === "failed") {
      logger.warn(
        `[solana-conn] chain ${this.opts.chainId} in failed state; retrying`,
      );
      void this.reconnect();
      return;
    }
    if (this.phase === "subscribing") {
      if (
        this.subscribedAt !== null &&
        now - this.subscribedAt > FIRST_SLOT_GRACE_MS
      ) {
        logger.warn(
          `[solana-conn] chain ${this.opts.chainId} no first slot within ${FIRST_SLOT_GRACE_MS}ms; rotating`,
        );
        void this.reconnect();
      }
      return;
    }
    if (
      this.lastSlotAt !== null &&
      now - this.lastSlotAt > SLOT_STALENESS_TIMEOUT_MS
    ) {
      logger.warn(
        `[solana-conn] chain ${this.opts.chainId} slot stream stale; reconnecting`,
      );
      void this.reconnect();
    }
  }

  private async reconnect(): Promise<void> {
    // reconnect() is always fired with `void`, so stop() can land in the middle
    // of it. Without these guards it resumes after the await and builds a fresh
    // Connection on a stopped object that has no watchdog left to tear it down.
    if (this.stopped || this.phase === "reconnecting") {
      return;
    }
    this.phase = "reconnecting";
    this.reconnects += 1;
    await this.removeSub();
    if (this.stopped) {
      this.phase = "idle";
      return;
    }
    this.connection = null;
    if (this.opts.endpoints.length > 1) {
      this.activeIndex = (this.activeIndex + 1) % this.opts.endpoints.length;
    }
    this.openAndSubscribe();
  }

  private async removeSub(): Promise<void> {
    const id = this.slotSubId;
    const connection = this.connection;
    // Cleared first. Clearing it after the await is what let the 88s hang keep
    // a dead subscription id visible to getHealth() for the whole wedge.
    this.slotSubId = null;
    if (id === null || !connection) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connection.removeSlotChangeListener(id).catch(() => {
          // best-effort; socket may already be gone
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            // Resolve rather than reject: this is best-effort cleanup and the
            // caller has nothing useful to do with a rejection. But count it -
            // this is the single number that turns a repeat of PD #33473 into a
            // five-minute diagnosis.
            this.abandonedSubscriptions += 1;
            logger.warn(
              `[solana-conn] chain ${this.opts.chainId} removeSlotChangeListener did not settle in ${REMOVE_SUB_TIMEOUT_MS}ms; abandoning subscription`,
            );
            // Without this the abandoned socket stays open for the life of the
            // process, and nothing restarts the process any more to cap it. The
            // epoch guard in openAndSubscribe() covers any notification that
            // lands before the close completes.
            closeAbandonedConnection(connection, this.opts.chainId);
            resolve();
          }, REMOVE_SUB_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async getBlock(
    slot: number,
    transactionDetails: "full" | "none",
  ): Promise<VersionedBlockResponse | null> {
    const config: GetVersionedBlockConfig = {
      commitment: toFinality(this.opts.commitment),
      maxSupportedTransactionVersion: 0,
      rewards: false,
      transactionDetails,
    };
    return (await this.getConnection().getBlock(
      slot,
      config,
    )) as VersionedBlockResponse | null;
  }

  async getProducedSlots(from: number, to: number): Promise<number[]> {
    return this.getConnection().getBlocks(
      from,
      to,
      toFinality(this.opts.commitment),
    );
  }

  async getCurrentSlot(): Promise<number> {
    return this.getConnection().getSlot(toFinality(this.opts.commitment));
  }

  /**
   * Server-side program-filtered signature query - the Solana analog of EVM
   * `eth_getLogs`'s `address` filter (used by the SignaturesSource).
   */
  async getSignaturesForAddress(
    address: string,
    options: SignaturesForAddressOptions,
  ): Promise<ConfirmedSignatureInfo[]> {
    return this.getConnection().getSignaturesForAddress(
      new PublicKey(address),
      options,
      toFinality(this.opts.commitment),
    );
  }

  async getTransaction(
    signature: string,
  ): Promise<VersionedTransactionResponse | null> {
    return this.getConnection().getTransaction(signature, {
      commitment: toFinality(this.opts.commitment),
      maxSupportedTransactionVersion: 0,
    });
  }

  getHealth(): ConnectionHealth {
    const state = this.currentState();
    return {
      chainId: this.opts.chainId,
      source: this.opts.source,
      connected: state === "live",
      state,
      reconnecting: state === "reconnecting",
      lastSlotAt: this.lastSlotAt,
      subscribedAt: this.subscribedAt,
      activeEndpoint:
        redactRpcUrl(this.opts.endpoints[this.activeIndex]?.wssUrl ?? null) ??
        "",
      endpointIndex: this.activeIndex,
      endpointCount: this.opts.endpoints.length,
      reconnects: this.reconnects,
      abandonedSubscriptions: this.abandonedSubscriptions,
      lastError: this.lastError,
    };
  }
}
