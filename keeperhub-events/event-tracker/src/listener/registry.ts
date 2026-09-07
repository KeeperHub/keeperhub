import type { SQSClient } from "@aws-sdk/client-sqs";
import { logger } from "../../lib/utils/logger";
import type { ChainProviderManager } from "../chains/provider-manager";
import type { AbiEvent } from "../chains/validation";
import type { DedupStore } from "./dedup";
import { EventListener } from "./event-listener";
import { formatError } from "./format-error";
import { InFlightTracker } from "./in-flight";
import { TokenBucketPacer } from "./pacer";
import { SHUTDOWN_DRAIN_TIMEOUT_MS } from "./shutdown";

/**
 * In-process registry of EventListener instances, keyed by workflow ID.
 * The Phase 4 reconciler will diff the active workflow list against this
 * registry and call add/remove to converge.
 *
 * All listeners share the same ChainProviderManager (one WSS per chain)
 * and the same DedupStore (one Redis client instead of per-workflow).
 *
 * Deliberately does not import the concrete `RedisDedupStore` factory so
 * that this module can be loaded by unit tests without requiring `ioredis`
 * at the test runtime. Production wiring of the factory lives in
 * `factory.ts`.
 */

export interface WorkflowRegistration {
  workflowId: string;
  userId: string;
  workflowName: string;
  chainId: number;
  wssUrl: string;
  /**
   * Optional secondary WSS endpoint. If primary is unreachable or rejects
   * `eth_subscribe`, ChainProviderManager falls through to this URL before
   * giving up. Populated from `chains.default_fallback_wss` when it parses
   * as a valid `ws://` / `wss://` URL.
   */
  fallbackWssUrl?: string;
  contractAddress: string;
  eventName: string;
  eventsAbiStrings: string[];
  rawEventsAbi: AbiEvent[];
  /**
   * Optional post-decode filters for the Transfer trigger.
   * `recipientFilter` matches the decoded `to` arg; `memoFilter` matches the
   * decoded `memo` (exact for a 0x + 64-hex value, prefix otherwise). Undefined
   * for generic Event triggers, which never filter on decoded args.
   */
  recipientFilter?: string;
  memoFilter?: string;
  /**
   * Stable hash over the listener-affecting fields of this registration.
   * Produced by `workflow-mapper.hashRegistration` and used by the Phase 4
   * reconciler to detect config changes (contract swap, event rename, ABI
   * update, user reassignment) and restart the listener rather than leave
   * it running with stale config.
   */
  configHash: string;
}

export interface RegistryDeps {
  providerManager: ChainProviderManager;
  dedup: DedupStore;
  sqs: SQSClient;
  sqsQueueUrl: string;
}

interface RegistryEntry {
  listener: EventListener;
  configHash: string;
}

export class ListenerRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly deps: RegistryDeps;
  /** One pacer per chain, shared by every listener on that chain. */
  private readonly pacers = new Map<number, TokenBucketPacer>();
  /** In-flight `onLog` dispatches across every listener, drained by stopAll. */
  private readonly inFlight = new InFlightTracker();
  /**
   * Aborted by `stopAll` to stop every parked dispatch. Terminal: a registry
   * that has been stopped is not restarted, the process exits behind it.
   */
  private readonly shutdown = new AbortController();

  /** Events released per second per chain when a batch contends the bucket. */
  private static readonly DRAIN_RATE_PER_SEC = 50;

  constructor(deps: RegistryDeps) {
    this.deps = deps;
  }

  /** Returns the shared pacer for a chain, creating it on first use. */
  private pacerFor(chainId: number): TokenBucketPacer {
    let pacer = this.pacers.get(chainId);
    if (!pacer) {
      pacer = new TokenBucketPacer(
        ListenerRegistry.DRAIN_RATE_PER_SEC,
        undefined,
        this.shutdown.signal,
      );
      this.pacers.set(chainId, pacer);
    }
    return pacer;
  }

  /**
   * Not concurrency-safe against interleaved `remove(workflowId)` calls
   * for the same id. The has() check and the final `listeners.set` straddle
   * an `await` on `listener.start()`, so a `remove` that lands in that
   * window sees nothing to remove, the add completes, and a zombie
   * listener is left registered.
   *
   * Phase 4's reconciler calls `add` and `remove` from a single sequential
   * loop inside `synchronizeData`, so this race cannot be observed in the
   * production code path. If a caller needs concurrent calls, wrap
   * Registry access in a serialising queue at the call site.
   */
  async add(reg: WorkflowRegistration): Promise<void> {
    if (this.entries.has(reg.workflowId)) {
      // Idempotent: Phase 4 reconciler handles config changes via
      // remove+add rather than in-place mutation.
      return;
    }
    const listener = new EventListener({
      ...reg,
      providerManager: this.deps.providerManager,
      dedup: this.deps.dedup,
      sqs: this.deps.sqs,
      sqsQueueUrl: this.deps.sqsQueueUrl,
      pacer: this.pacerFor(reg.chainId),
      inFlight: this.inFlight,
      shutdownSignal: this.shutdown.signal,
    });
    try {
      await listener.start();
    } catch (err) {
      logger.warn(
        `[ListenerRegistry] failed to start listener ${reg.workflowId}: ${formatError(err)}`,
      );
      return;
    }
    this.entries.set(reg.workflowId, {
      listener,
      configHash: reg.configHash,
    });
  }

  remove(workflowId: string): void {
    const entry = this.entries.get(workflowId);
    if (!entry) {
      return;
    }
    entry.listener.stop();
    this.entries.delete(workflowId);
  }

  has(workflowId: string): boolean {
    return this.entries.has(workflowId);
  }

  /**
   * Returns the configHash stored when the listener was registered, or
   * `undefined` if no listener is registered under that id. Callers compare
   * this to a fresh registration's configHash to detect workflow config
   * changes and trigger a remove+add restart.
   */
  getConfigHash(workflowId: string): string | undefined {
    return this.entries.get(workflowId)?.configHash;
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Terminal teardown, called from the SIGTERM path.
   *
   * Order is load-bearing. Unsubscribing first removes each listener from the
   * provider manager's subscriber set, so no further log can start a handler
   * while an already-dispatched one keeps its captured reference. Aborting
   * next releases every parked dispatch, which is what keeps the drain inside
   * its budget: waiting out the pace instead would cover only
   * `SHUTDOWN_DRAIN_TIMEOUT_MS * drainRate` events and kill the rest. The
   * drain then waits for the sends themselves.
   *
   * Bounded rather than unbounded on purpose: a drain that outlives the K8s
   * grace period is SIGKILLed with nothing logged. On timeout the remaining
   * handlers are lost exactly as they are without a drain, but the count is
   * on the record.
   */
  async stopAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      entry.listener.stop();
    }
    this.shutdown.abort();

    const outstanding = this.inFlight.size;
    if (outstanding > 0) {
      logger.log(
        `[ListenerRegistry] draining ${outstanding} in-flight dispatch(es) (up to ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms)`,
      );
    }
    const drained = await this.inFlight.drain(SHUTDOWN_DRAIN_TIMEOUT_MS);
    if (!drained) {
      logger.error(
        `[ListenerRegistry] drain timed out with ${this.inFlight.size} dispatch(es) unfinished; those events are lost`,
      );
    }

    this.entries.clear();
    this.pacers.clear();
  }
}
