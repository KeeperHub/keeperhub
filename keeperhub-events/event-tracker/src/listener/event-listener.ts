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
   * Maximum jitter applied before forwarding a matched event to SQS.
   * Spreads downstream load when many events fire simultaneously. Tests
   * should pass 0 to keep runs deterministic.
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
      handler: (log) => this.onLog(log),
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

      const maxJitter = this.opts.jitterMs ?? DEFAULT_JITTER_MS;
      if (maxJitter > 0) {
        await new Promise((r) => setTimeout(r, Math.random() * maxJitter));
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
      await this.sendToSqs(payload);

      // Mark after the send. A crash between send and mark would re-fire
      // the event on the next reconnect (documented best-effort trade).
      // A mark failure here does not un-send SQS - fine, dedup is best-effort.
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

  private async sendToSqs(payload: unknown): Promise<void> {
    // KEEP-693: pre-create a phantom row (best-effort) so the run is visible
    // even if it never reaches the executor, and carry its id so the executor
    // upgrades that row instead of inserting.
    const executionId = await createPhantomExecution(
      this.opts.workflowId,
      this.opts.userId,
    );

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
