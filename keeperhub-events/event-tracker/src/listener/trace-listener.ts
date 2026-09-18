import type { SQSClient } from "@aws-sdk/client-sqs";
import {
  createPhantomExecution,
  failPhantomExecution,
} from "../../lib/phantom";
import { logger } from "../../lib/utils/logger";
import { enqueueWorkflowEventTrigger } from "../../lib/workflow-sqs";
import type {
  ChainProviderManager,
  TraceCallFrame,
  Unsubscribe,
} from "../chains/provider-manager";
import type { InFlightTracker } from "./in-flight";
import type { TokenBucketPacer } from "./pacer";
import type { TraceSubscription } from "./trace-subscription";

/**
 * TraceListener is the trace-trigger counterpart of EventListener and
 * StateThresholdListener (issue #2464). It registers with ChainProviderManager's
 * shared block subscription and trace-fetch path, so many trace subscriptions
 * on one chain cost one debug_traceBlockByNumber per block between them.
 *
 * Trace triggers dispatch per matched call frame rather than per transaction,
 * so the dedup key includes frameIndex. Dedup is handled via the phantom
 * execution's dispatchKey (workflowId:chainId:txHash:frameIndex).
 */

export interface TraceListenerOptions {
  workflowId: string;
  userId: string;
  workflowName: string;
  chainId: number;
  wssUrl: string;
  fallbackWssUrl?: string;
  subscription: TraceSubscription;
  sqs: SQSClient;
  sqsQueueUrl: string;
  providerManager: ChainProviderManager;
  pacer?: TokenBucketPacer;
  inFlight?: InFlightTracker;
}

/**
 * `callTracer` reports `value` as a hex quantity. The trigger's output
 * contract documents it as wei in a decimal string, and `minValueWei` is
 * configured in decimal, so `{{Trigger.value}}` rendered
 * `0x16345785d8a0000` against a field that promises `100000000000000000`.
 * Converted once here, at the boundary between the matcher's shape and the
 * workflow payload, rather than in the matcher, which compares it as a
 * BigInt and does not care which base it arrived in.
 *
 * A value the tracer did not send, or one it sent malformed, becomes "0"
 * rather than propagating a string no downstream step can parse.
 */
function toDecimalWei(value: string): string {
  try {
    return BigInt(value).toString(10);
  } catch {
    return "0";
  }
}

export class TraceListener {
  private readonly opts: TraceListenerOptions;
  private unsubscribe: Unsubscribe | null = null;

  constructor(opts: TraceListenerOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    // Register trace subscription with provider manager
    this.unsubscribe = await this.opts.providerManager.subscribeToTrace({
      chainId: this.opts.chainId,
      wssUrl: this.opts.wssUrl,
      fallbackWssUrl: this.opts.fallbackWssUrl,
      contractAddress: this.opts.subscription.contractAddress,
      caller: this.opts.subscription.caller,
      selector: this.opts.subscription.selector,
      callTypes: this.opts.subscription.callTypes,
      minValueWei: this.opts.subscription.minValueWei,
      status: this.opts.subscription.status,
      handler: this.onTrace.bind(this),
    });

    logger.log(
      `[TraceListener] started ${this.opts.workflowId} on chain ${this.opts.chainId}`,
    );
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    logger.log(`[TraceListener] stopped ${this.opts.workflowId}`);
  }

  private async onTrace(matches: TraceCallFrame[]): Promise<void> {
    // Process each matched frame
    const dispatches = matches.map((match) => this.dispatchMatch(match));

    // Track in-flight if available
    if (this.opts.inFlight) {
      await Promise.all(dispatches.map((d) => this.opts.inFlight!.track(d)));
    } else {
      await Promise.all(dispatches);
    }
  }

  private async dispatchMatch(match: TraceCallFrame): Promise<void> {
    // Dedup key includes frame index to distinguish multiple matches in one tx
    const dispatchKey = `${this.opts.workflowId}:${this.opts.chainId}:${match.transactionHash}:${match.frameIndex}`;

    const { executionId, alreadyExisted, refused } =
      await createPhantomExecution(
        this.opts.workflowId,
        this.opts.userId,
        dispatchKey,
      );

    if (refused) {
      logger.log(
        `[TraceListener:${this.opts.workflowId}] skipping refused dispatch (${refused})`,
      );
      return;
    }

    if (alreadyExisted) {
      logger.log(
        `[TraceListener:${this.opts.workflowId}] skipping duplicate dispatch for ${dispatchKey}`,
      );
      return;
    }

    try {
      // Wait for pacer token if available
      if (this.opts.pacer) {
        await this.opts.pacer.take();
      }

      // Build trigger data matching the schema from #2464
      const triggerData = {
        triggerType: "Trace",
        chainId: this.opts.chainId,
        blockNumber: match.blockNumber,
        transactionHash: match.transactionHash,
        transactionIndex: match.transactionIndex,
        frameIndex: match.frameIndex,
        // The payload field keeps its name. The frame carries the matcher's
        // own `type`, which is the same value upper-cased the same way.
        callType: match.type,
        from: match.from,
        to: match.to,
        value: toDecimalWei(match.value),
        selector: match.selector,
        input: match.input,
        depth: match.depth,
        reverted: match.reverted,
      };

      await enqueueWorkflowEventTrigger(this.opts.sqs, this.opts.sqsQueueUrl, {
        executionId,
        workflowId: this.opts.workflowId,
        userId: this.opts.userId,
        triggerData,
      });
    } catch (err) {
      if (executionId) {
        await failPhantomExecution(executionId, "ES-0001", String(err));
      }
      logger.warn(
        `[TraceListener] dispatch failed for ${this.opts.workflowId}: ${String(err)}`,
      );
    }
  }
}
