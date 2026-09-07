import type { SQSClient } from "@aws-sdk/client-sqs";
import type { ethers } from "ethers";
import { hexlify, toUtf8Bytes } from "ethers";
import {
  createPhantomExecution,
  failPhantomExecution,
} from "../../lib/phantom";
import { logger } from "../../lib/utils/logger";
import { enqueueWorkflowEventTrigger } from "../../lib/workflow-sqs";
import {
  buildEventPayload,
  extractEventArgs,
} from "../chains/event-serializer";
import { getInterface } from "../chains/interface-cache";
import type {
  ChainProviderManager,
  Unsubscribe,
} from "../chains/provider-manager";
import type { AbiEvent } from "../chains/validation";
import type { DedupStore } from "./dedup";
import { formatError } from "./format-error";
import type { InFlightTracker } from "./in-flight";
import type { TokenBucketPacer } from "./pacer";
import { abortableSleep } from "./shutdown";

/**
 * EventListener encapsulates a single workflow's contract-event listener.
 * Registers with ChainProviderManager's shared block-subscription + demux,
 * so many listeners on the same chain share one WSS connection.
 */

const DEFAULT_JITTER_MS = 10_000;

/** A full pre-hashed bytes32 memo (0x + 64 hex), matched exactly. */
const BYTES32_HEX = /^0x[0-9a-fA-F]{64}$/;

/**
 * Post-decode filter for the Transfer trigger. Returns true
 * (forward the event) when no filter is set. Otherwise the decoded `to` must
 * equal the watched deposit address (case-insensitive), and the decoded `memo`
 * must match the configured filter: an exact bytes32 for a 0x + 64-hex value,
 * or a utf8 prefix otherwise (the transfer step right-pads a plain-text memo
 * into the bytes32, so a utf8-hex prefix aligns on byte boundaries).
 */
export function paymentEventMatches(params: {
  to: unknown;
  memo: unknown;
  recipientFilter?: string;
  memoFilter?: string;
}): boolean {
  const { to, memo, recipientFilter, memoFilter } = params;

  if (recipientFilter) {
    if (
      typeof to !== "string" ||
      to.toLowerCase() !== recipientFilter.toLowerCase()
    ) {
      return false;
    }
  }

  if (memoFilter) {
    if (typeof memo !== "string") {
      return false;
    }
    const memoHex = memo.toLowerCase();
    if (BYTES32_HEX.test(memoFilter)) {
      return memoHex === memoFilter.toLowerCase();
    }
    const prefixHex = hexlify(toUtf8Bytes(memoFilter));
    return memoHex.startsWith(prefixHex.toLowerCase());
  }

  return true;
}

export interface EventListenerOptions {
  workflowId: string;
  userId: string;
  workflowName: string;
  chainId: number;
  wssUrl: string;
  fallbackWssUrl?: string;
  contractAddress: string;
  eventName: string;
  eventsAbiStrings: string[];
  rawEventsAbi: AbiEvent[];

  /**
   * Optional post-decode filters (Transfer trigger). Undefined
   * for generic Event triggers, which forward every matching event.
   */
  recipientFilter?: string;
  memoFilter?: string;

  sqs: SQSClient;
  sqsQueueUrl: string;
  dedup: DedupStore;
  providerManager: ChainProviderManager;

  /**
   * Optional per-chain pacer shared by every listener on the same chain.
   * When set, `pacer.take()` is awaited before forwarding a matched event to
   * SQS, replacing the fixed random jitter: a lone event forwards
   * immediately (the bucket holds tokens), a large simultaneous batch is
   * paced at the bucket's drain rate. When unset the legacy
   * `jitterMs`/`DEFAULT_JITTER_MS` behaviour applies.
   */
  pacer?: TokenBucketPacer;

  /**
   * Optional registry-wide tracker for in-flight `onLog` promises. When set,
   * every dispatch is registered with it so `ListenerRegistry.stopAll` can
   * wait for handlers that are mid-flight at SIGTERM. Without it a parked or
   * dispatching event dies with the process: it has no SQS message and no
   * phantom row yet, and the provider manager keeps no cursor to replay it.
   */
  inFlight?: InFlightTracker;

  /**
   * Optional registry-wide shutdown signal. Once aborted the dispatch stops
   * parking - both the pacer and the jitter below return immediately - so the
   * drain that follows costs the dispatch rather than the remaining pace.
   * Aborting does not cancel an event; it forwards it now.
   */
  shutdownSignal?: AbortSignal;

  /**
   * Maximum jitter applied before forwarding a matched event to SQS.
   * Spreads downstream load when many events fire simultaneously. Tests
   * should pass 0 to keep runs deterministic.
   *
   * Ignored when `pacer` is set; kept for the legacy path and for tests of
   * the jitter branch itself.
   */
  jitterMs?: number;
}

export class EventListener {
  private readonly opts: EventListenerOptions;
  private unsubscribe: Unsubscribe | null = null;
  private started = false;

  constructor(opts: EventListenerOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const iface = getInterface(this.opts.eventsAbiStrings);
    const eventFragment = iface.getEvent(this.opts.eventName);
    if (!eventFragment) {
      // Enumerate the events the ABI does contain so the operator can
      // see the mismatch in one log line. A blank list means the ABI
      // has no event fragments at all — typically a wrong-ABI config
      // rather than a typo'd event name.
      const availableEvents: string[] = [];
      iface.forEachEvent((fragment) => {
        availableEvents.push(fragment.name);
      });
      const available =
        availableEvents.length > 0 ? availableEvents.join(", ") : "(none)";
      throw new Error(
        `EventListener(${this.opts.workflowId}): event "${this.opts.eventName}" not found in ABI. Available events: ${available}`,
      );
    }

    this.unsubscribe = await this.opts.providerManager.subscribeToLogs({
      chainId: this.opts.chainId,
      wssUrl: this.opts.wssUrl,
      fallbackWssUrl: this.opts.fallbackWssUrl,
      address: this.opts.contractAddress,
      topic0: eventFragment.topicHash,
      // Registered with the tracker so shutdown can wait for it. `onLog`
      // swallows its own errors, so the tracked promise never rejects.
      handler: (log) => {
        const dispatch = this.onLog(log);
        return this.opts.inFlight
          ? this.opts.inFlight.track(dispatch)
          : dispatch;
      },
    });
    this.started = true;
    logger.log(
      `[EventListener:${this.opts.workflowId}] started - name="${this.opts.workflowName}" chain=${this.opts.chainId} address=${this.opts.contractAddress} event=${this.opts.eventName}`,
    );
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.started = false;
    logger.log(`[EventListener:${this.opts.workflowId}] stopped`);
  }

  isStarted(): boolean {
    return this.started;
  }

  private matchesFilters(parsed: ethers.LogDescription): boolean {
    return paymentEventMatches({
      to: parsed.args?.to as unknown,
      memo: parsed.args?.memo as unknown,
      recipientFilter: this.opts.recipientFilter,
      memoFilter: this.opts.memoFilter,
    });
  }

  private async onLog(log: ethers.Log): Promise<void> {
    try {
      const iface = getInterface(this.opts.eventsAbiStrings);
      const parsed = iface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (!parsed || parsed.name !== this.opts.eventName) {
        return;
      }

      // Post-decode filtering for the Transfer trigger. No-op
      // when neither filter is set (generic Event triggers forward everything).
      if (!this.matchesFilters(parsed)) {
        return;
      }

      const txHash = log.transactionHash;
      if (!txHash) {
        logger.warn(
          `[EventListener:${this.opts.workflowId}] log missing transactionHash; skipping`,
        );
        return;
      }

      // Pace the dispatch. With a pacer (the production path, see registry)
      // a lone event forwards immediately and a large batch drains at the
      // per-chain rate. Without one, keep the legacy random jitter so the
      // load-spreading property survives for direct/unit constructions.
      if (this.opts.pacer) {
        await this.opts.pacer.take();
      } else {
        const maxJitter = this.opts.jitterMs ?? DEFAULT_JITTER_MS;
        if (maxJitter > 0) {
          await abortableSleep(
            Math.random() * maxJitter,
            this.opts.shutdownSignal,
          );
        }
      }

      // Dedup is best-effort. If the read throws we fall through and
      // forward the event anyway; the downstream workflow executor is the
      // idempotency authority. If the read succeeds and reports a hit,
      // skip forwarding.
      let alreadyProcessed = false;
      try {
        alreadyProcessed = await this.opts.dedup.isProcessed(
          this.opts.workflowId,
          txHash,
        );
      } catch (err) {
        logger.warn(
          `[EventListener:${this.opts.workflowId}] dedup isProcessed failed, proceeding: ${formatError(err)}`,
        );
      }
      if (alreadyProcessed) {
        logger.log(
          `[EventListener:${this.opts.workflowId}] ${txHash} already processed`,
        );
        return;
      }

      const args = extractEventArgs(parsed, this.opts.rawEventsAbi);
      const payload = buildEventPayload(log, parsed, args);
      // One key per (workflow, chain, transaction, log): two matching logs in
      // one transaction are two distinct runs. This is the guard that holds
      // across a reconnect replay, a reorg re-emit and a crash between the
      // send and the mark below; the Redis dedup is best-effort and per tx.
      const dispatchKey = `event:${this.opts.workflowId}:${this.opts.chainId}:${txHash}:${log.index}`;
      await this.sendToSqs(payload, dispatchKey);

      // Mark after the send, and after a refusal too: a refused event is
      // settled, and leaving it unmarked only buys another admission
      // round-trip the next time a reconnect replays the log.
      // A crash between send and mark would re-fire the event on the next
      // reconnect (documented best-effort trade). A mark failure here does not
      // un-send SQS - fine, dedup is best-effort.
      try {
        await this.opts.dedup.markProcessed(this.opts.workflowId, txHash);
      } catch (err) {
        logger.warn(
          `[EventListener:${this.opts.workflowId}] dedup markProcessed failed: ${formatError(err)}`,
        );
      }
    } catch (err) {
      logger.warn(
        `[EventListener:${this.opts.workflowId}] handler error: ${formatError(err)}`,
      );
    }
  }

  private async sendToSqs(
    payload: unknown,
    dispatchKey: string,
  ): Promise<void> {
    // KEEP-693: pre-create a phantom row (best-effort) so the run is visible
    // even if it never reaches the executor, and carry its id so the executor
    // upgrades that row instead of inserting.
    const { executionId, alreadyExisted, refused } =
      await createPhantomExecution(
        this.opts.workflowId,
        this.opts.userId,
        dispatchKey,
      );

    // Refused on plan grounds: the executor would refuse the same run, and a
    // busy contract would otherwise pay for that round-trip on every match.
    if (refused) {
      logger.log(
        `[EventListener:${this.opts.workflowId}] skipping refused dispatch (${refused})`,
      );
      return;
    }

    // An earlier delivery of this log already created and enqueued the row
    // (the Redis dedup missed it, or a crash landed between the send and the
    // mark). Enqueueing again would run it twice; returning lets the caller
    // mark the event processed.
    if (alreadyExisted) {
      logger.log(
        `[EventListener:${this.opts.workflowId}] skipping duplicate dispatch for ${dispatchKey} (already enqueued)`,
      );
      return;
    }

    try {
      await enqueueWorkflowEventTrigger(this.opts.sqs, this.opts.sqsQueueUrl, {
        executionId,
        workflowId: this.opts.workflowId,
        userId: this.opts.userId,
        triggerData: payload,
      });
    } catch (err) {
      if (executionId) {
        await failPhantomExecution(
          executionId,
          "ES-0001",
          `Event trigger failed to dispatch: ${formatError(err)}`,
        );
      }
      throw err;
    }

    logger.log(`[EventListener:${this.opts.workflowId}] enqueued to SQS`);
  }
}
