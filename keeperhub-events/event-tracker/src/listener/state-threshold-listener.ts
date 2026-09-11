import type { SQSClient } from "@aws-sdk/client-sqs";
import {
  createPhantomExecution,
  failPhantomExecution,
} from "../../lib/phantom";
import { logger } from "../../lib/utils/logger";
import { enqueueWorkflowEventTrigger } from "../../lib/workflow-sqs";
import type { Aggregate3Result } from "../chains/multicall3";
import type {
  ChainProviderManager,
  Unsubscribe,
} from "../chains/provider-manager";
import type { ArmStateStore } from "./arm-state";
import { formatError } from "./format-error";
import type { InFlightTracker } from "./in-flight";
import type { TokenBucketPacer } from "./pacer";
import {
  type ArmState,
  type StateThresholdSubscription,
  decodeCallResult,
  evaluateThreshold,
  initialArmState,
} from "./state-threshold";

/**
 * StateThresholdListener is the state-trigger counterpart of EventListener
 * (issue #2240). It registers with ChainProviderManager's shared block
 * subscription and drain loop, so many state subscriptions on one chain cost
 * one batched `eth_call` per drain between them.
 *
 * Arming state is held in memory and written through to the store on every
 * transition. The store is read exactly once, at start, which is the only
 * moment a durable read answers a question the process cannot answer itself:
 * "was this subscription already inside an arming episode before I existed?"
 */

export interface StateThresholdListenerOptions {
  workflowId: string;
  userId: string;
  workflowName: string;
  chainId: number;
  wssUrl: string;
  fallbackWssUrl?: string;
  subscription: StateThresholdSubscription;

  sqs: SQSClient;
  sqsQueueUrl: string;
  armStore: ArmStateStore;
  providerManager: ChainProviderManager;

  /** Shared per-chain pacer, as for EventListener. */
  pacer?: TokenBucketPacer;
  /** Registry-wide tracker so shutdown can drain a dispatch mid-flight. */
  inFlight?: InFlightTracker;
}

export class StateThresholdListener {
  private readonly opts: StateThresholdListenerOptions;
  private unsubscribe: Unsubscribe | null = null;
  private started = false;
  /**
   * Authoritative arming state while the process lives. Null only before the
   * first sample resolves it - a cold start cannot pick a generation before
   * it knows a block height to seed one from.
   */
  private armState: ArmState | null = null;
  /**
   * True once the store has been consulted. Separate from `armState` being
   * non-null because "the store had nothing" is a resolved answer that still
   * leaves the state to be seeded from the first sampled block.
   */
  private armStateLoaded = false;

  constructor(opts: StateThresholdListenerOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const sub = this.opts.subscription;
    // Read before subscribing. A resume that landed after the first sample
    // would evaluate against a cold-start generation and dispatch for an
    // episode that was already dispatched before the restart.
    try {
      this.armState = await this.opts.armStore.load(sub.subscriptionId);
      this.armStateLoaded = true;
    } catch (err) {
      // Left unloaded rather than seeded: `onSample` retries the read, and a
      // store that never answers costs samples instead of manufacturing
      // duplicate dispatches out of an outage.
      logger.warn(
        `[StateThresholdListener:${this.opts.workflowId}] arm-state load failed, will retry on first sample: ${formatError(err)}`,
      );
    }

    this.unsubscribe = await this.opts.providerManager.subscribeToState({
      chainId: this.opts.chainId,
      wssUrl: this.opts.wssUrl,
      fallbackWssUrl: this.opts.fallbackWssUrl,
      contractAddress: sub.contractAddress,
      callData: sub.callData,
      handler: (result, blockNumber) => {
        const dispatch = this.onSample(result, blockNumber);
        return this.opts.inFlight
          ? this.opts.inFlight.track(dispatch)
          : dispatch;
      },
    });
    this.started = true;
    logger.log(
      `[StateThresholdListener:${this.opts.workflowId}] started - name="${this.opts.workflowName}" chain=${this.opts.chainId} address=${sub.contractAddress} comparator=${sub.comparator} threshold=${sub.threshold}`,
    );
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.started = false;
    logger.log(`[StateThresholdListener:${this.opts.workflowId}] stopped`);
  }

  isStarted(): boolean {
    return this.started;
  }

  /** Current arming state, or null before the first sample. For tests. */
  getArmState(): ArmState | null {
    return this.armState;
  }

  private async onSample(
    result: Aggregate3Result,
    blockNumber: number,
  ): Promise<void> {
    try {
      const sub = this.opts.subscription;

      if (!this.armStateLoaded) {
        try {
          this.armState = await this.opts.armStore.load(sub.subscriptionId);
          this.armStateLoaded = true;
        } catch (err) {
          logger.warn(
            `[StateThresholdListener:${this.opts.workflowId}] arm-state load failed, skipping this sample: ${formatError(err)}`,
          );
          return;
        }
      }

      const value = decodeCallResult(result, sub.outputTypes, sub.outputIndex);
      if (value === null) {
        // A reverting view function or a return that does not match the
        // declared outputs. Not an observation, so not evidence either way
        // about the threshold - the sample is dropped, not interpreted.
        logger.warn(
          `[StateThresholdListener:${this.opts.workflowId}] block=${blockNumber} call did not decode to a comparable value; skipping sample`,
        );
        return;
      }

      const priorState = this.armState ?? initialArmState(blockNumber);
      const { fired, nextState } = evaluateThreshold(
        sub,
        value,
        blockNumber,
        priorState,
      );

      if (fired) {
        if (this.opts.pacer) {
          await this.opts.pacer.take();
        }
        try {
          await this.sendToSqs(fired.dispatchKey, {
            triggerType: "stateThreshold",
            chainId: sub.chainId,
            contractAddress: sub.contractAddress,
            blockNumber,
            comparator: sub.comparator,
            threshold: sub.threshold.toString(),
            observedValue: value.toString(),
          });
        } catch (err) {
          // The state still advances to FIRED. The phantom row created above
          // records the failure, and a retry under the same generation would
          // be refused by the unique index anyway, so holding ARMED would buy
          // a dispatch that cannot succeed and a re-evaluation every drain.
          logger.warn(
            `[StateThresholdListener:${this.opts.workflowId}] dispatch failed for ${fired.dispatchKey}: ${formatError(err)}`,
          );
        }
      }

      await this.persistArmState(nextState);
    } catch (err) {
      logger.warn(
        `[StateThresholdListener:${this.opts.workflowId}] handler error: ${formatError(err)}`,
      );
    }
  }

  /**
   * Advance the in-memory state, then write it through. Memory first: a store
   * write that fails must not leave this process re-evaluating against a
   * state it has already moved past and dispatching again on the next drain.
   * The cost of a lost write is a duplicate after a restart, which is the
   * direction the whole design already fails in.
   */
  private async persistArmState(next: ArmState): Promise<void> {
    const unchanged =
      this.armState !== null &&
      this.armState.phase === next.phase &&
      this.armState.armGeneration === next.armGeneration &&
      this.armState.lastFiredBlock === next.lastFiredBlock;
    this.armState = next;
    if (unchanged) {
      return;
    }
    try {
      await this.opts.armStore.save(
        this.opts.subscription.subscriptionId,
        next,
      );
    } catch (err) {
      logger.warn(
        `[StateThresholdListener:${this.opts.workflowId}] arm-state save failed: ${formatError(err)}`,
      );
    }
  }

  /**
   * Identical in shape to EventListener's, including the phantom pre-create
   * whose unique index on the dispatch key is what makes the arm generation a
   * durable guard rather than an in-memory convention.
   */
  private async sendToSqs(
    dispatchKey: string,
    payload: unknown,
  ): Promise<void> {
    const { executionId, alreadyExisted, refused } =
      await createPhantomExecution(
        this.opts.workflowId,
        this.opts.userId,
        dispatchKey,
      );

    if (refused) {
      logger.log(
        `[StateThresholdListener:${this.opts.workflowId}] skipping refused dispatch (${refused})`,
      );
      return;
    }

    // This arming episode already dispatched: a redelivery after a reorg, or
    // a restart that resumed a generation whose dispatch had already landed.
    if (alreadyExisted) {
      logger.log(
        `[StateThresholdListener:${this.opts.workflowId}] skipping duplicate dispatch for ${dispatchKey} (already enqueued)`,
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
          `State threshold trigger failed to dispatch: ${formatError(err)}`,
        );
      }
      throw err;
    }

    logger.log(
      `[StateThresholdListener:${this.opts.workflowId}] enqueued to SQS for ${dispatchKey}`,
    );
  }
}
