import { ethers } from "ethers";
import type { Aggregate3Result } from "../chains/multicall3";

/**
 * Core evaluation logic for issue #2240 - "Workflows cannot trigger on a
 * threshold over contract state, only on emitted events".
 *
 * This module is free of provider/subscription wiring: it takes decoded
 * `eth_call` results in and produces ARMED/FIRED transitions out, so it can be
 * unit tested without a live chain. `ChainProviderManager.subscribeToState`
 * does the I/O and `StateThresholdListener` owns the state and the dispatch.
 *
 * Dedup identity - arm generation
 * -------------------------------
 * The Redis dedup store is explicitly not the authority (`event-listener.ts`
 * says so above its own read). The durable guard is the dispatch key carried
 * into `createPhantomExecution`, whose unique index turns a second create for
 * the same key into an `alreadyExisted` no-op. So the question a state trigger
 * has to answer is what dispatch key a *condition* produces, not what replaces
 * `txHash` in Redis:
 *
 *   event:  event:{workflowId}:{chainId}:{txHash}:{logIndex}
 *   state:  state:{workflowId}:{chainId}:{subscriptionId}:{armGeneration}
 *
 * `armGeneration` identifies one arming episode. It is fixed for as long as
 * the subscription stays armed and changes when it re-arms, so:
 *
 *  - Edge detection falls out of the key. While the condition holds across
 *    many samples the generation does not move, every evaluation produces the
 *    same key, the unique index reports `alreadyExisted` and the enqueue is
 *    skipped. "Fires on every sample while the condition holds" is not
 *    guarded against, it is unrepresentable.
 *  - Reorg-safe for the same reason. A crossing re-observed at a different
 *    height still belongs to the same episode and yields the same key, where a
 *    `blockNumber` term would fire twice.
 *
 * The generation's *value* is the block at which the subscription last became
 * armed, rather than a counter incremented on each re-arm. Nothing in the
 * event tracker persists per-subscription rows - subscriptions are rebuilt
 * from the workflow API on every reconcile pass and held in memory, and the
 * only durable stores this process reaches are Redis (best-effort, TTL'd) and
 * the main app's DB behind the internal HTTP API. A counter that lost its
 * store would restart at 0 and every key it then produced would collide with
 * one already in the unique index, so every dispatch would be swallowed as a
 * duplicate and the subscription would be wedged for good. Block heights
 * advance, so a generation re-seeded after a total loss of state is always a
 * value the index has not seen. The cost is the opposite failure - a process
 * that dies while a condition is holding re-arms at a higher generation and
 * fires once more - which is the direction a threshold alert should fail in.
 *
 * Exit predicate
 * --------------
 * The exit predicate is deliberately not `!enter`; that is the oscillation bug
 * relocated. The band is explicit: enter at `x < threshold`, exit at
 * `x > threshold + delta`, with `delta` supplied per subscription and
 * defaulting to `DEFAULT_HYSTERESIS_BPS` of the threshold. Between the two the
 * subscription stays FIRED and dispatches nothing.
 *
 * Sampling
 * --------
 * State is read once per drain at the head block, not once per block. A chain
 * accumulating against the high-water mark does not have its intermediate
 * blocks sampled, so a crossing that both enters and exits inside one
 * accumulation window is not observed at all. This is a real semantic
 * difference from the log path, whose ranged `eth_getLogs` is contiguous and
 * therefore lossless, and a state trigger cannot inherit it.
 */

/**
 * Default width of the re-arm band, in basis points of the threshold. 200 bps
 * (2%) is a prior, not a measurement - there is an open offer on issue #2240
 * to derive it from historical Aave health-factor series, and this constant is
 * where that number lands when it exists.
 */
export const DEFAULT_HYSTERESIS_BPS = 200n;

export type ThresholdComparator = "lt" | "lte" | "gt" | "gte";

export type ArmPhase = "ARMED" | "FIRED";

export interface StateThresholdSubscription {
  /**
   * Stable identity of this subscription's *configuration*. Derived from the
   * threshold config by `hashStateRegistration`, so editing the threshold
   * yields a new id and therefore a fresh arming episode rather than
   * inheriting a generation that would suppress the first dispatch.
   */
  subscriptionId: string;
  workflowId: string;
  chainId: number;
  /** Contract the view function is called on. */
  contractAddress: string;
  /** ABI-encoded calldata for the view function. */
  callData: string;
  /**
   * ABI output types of the called function, in declaration order. Carried
   * with the call because the decoder cannot recover them from `callData`:
   * every 32-byte word decodes as a `uint256`, so a decoder that guesses
   * would read an `int256` of -1 as 2^256 - 1 and turn a breach into a
   * comfortable value on an `lt` threshold.
   */
  outputTypes: string[];
  /** Which output to compare, as an index into `outputTypes`. */
  outputIndex: number;
  /** Scaled integer the decoded value is compared against. */
  threshold: bigint;
  comparator: ThresholdComparator;
  /**
   * Width of the re-arm band in the same units as `threshold`. Must be >= 0.
   * Defaults to `DEFAULT_HYSTERESIS_BPS` of `|threshold|` when undefined.
   */
  hysteresis?: bigint;
  /**
   * Optional floor on the number of blocks between two dispatches. A cooldown
   * delays a dispatch, it does not cancel one: the subscription stays armed
   * and fires at the first sample past the floor.
   */
  minBlocksBetweenFires?: number;
}

/**
 * Per-subscription state that must survive a process bounce for edge
 * detection to hold across one.
 */
export interface ArmState {
  phase: ArmPhase;
  /**
   * Block at which this arming episode began. Fixed while armed, and fixed
   * across the FIRED stretch that follows so a redelivered dispatch rebuilds
   * the same key. Moves only on re-arm.
   */
  armGeneration: number;
  /** Block of the last dispatch, for `minBlocksBetweenFires`. */
  lastFiredBlock: number | null;
}

export interface ThresholdFire {
  subscriptionId: string;
  workflowId: string;
  chainId: number;
  /** Block the value was sampled at. Not part of the dispatch key. */
  blockNumber: number;
  /** `state:{workflowId}:{chainId}:{subscriptionId}:{armGeneration}`. */
  dispatchKey: string;
  observedValue: bigint;
  threshold: bigint;
  comparator: ThresholdComparator;
}

export interface EvaluationResult {
  /** Present only when this sample should dispatch a workflow trigger. */
  fired: ThresholdFire | null;
  /**
   * State to persist for this subscription after this sample, fired or not.
   * Applied by the caller after the dispatch attempt regardless of its
   * outcome: a dispatch that reached `createPhantomExecution` has a row
   * recording it either way, and retrying under the same generation would be
   * refused by the unique index anyway.
   */
  nextState: ArmState;
}

/** The state a subscription starts in when nothing durable is known about it. */
export function initialArmState(blockNumber: number): ArmState {
  return { phase: "ARMED", armGeneration: blockNumber, lastFiredBlock: null };
}

export function buildStateDispatchKey(
  sub: Pick<
    StateThresholdSubscription,
    "workflowId" | "chainId" | "subscriptionId"
  >,
  armGeneration: number,
): string {
  return `state:${sub.workflowId}:${sub.chainId}:${sub.subscriptionId}:${armGeneration}`;
}

function enterHolds(
  value: bigint,
  threshold: bigint,
  comparator: ThresholdComparator,
): boolean {
  switch (comparator) {
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
  }
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** Band width, defaulting to `DEFAULT_HYSTERESIS_BPS` of `|threshold|`. */
function resolveHysteresis(sub: StateThresholdSubscription): bigint {
  if (sub.hysteresis !== undefined) {
    return sub.hysteresis < 0n ? 0n : sub.hysteresis;
  }
  return (abs(sub.threshold) * DEFAULT_HYSTERESIS_BPS) / 10_000n;
}

/**
 * Whether a FIRED subscription has cleared far enough to re-arm. Strictly
 * beyond the threshold on the safe side by the band width, never merely the
 * negation of the enter predicate - `!enter` is what lets a value resting on
 * the boundary re-arm and fire on alternate samples indefinitely.
 */
export function exitHolds(
  value: bigint,
  sub: StateThresholdSubscription,
): boolean {
  const delta = resolveHysteresis(sub);
  switch (sub.comparator) {
    case "lt":
    case "lte":
      // Enter is below the threshold, so safety is above it.
      return value > sub.threshold + delta;
    case "gt":
    case "gte":
      return value < sub.threshold - delta;
  }
}

/**
 * Pure evaluation step for one sample of one subscription. No I/O.
 */
export function evaluateThreshold(
  sub: StateThresholdSubscription,
  observedValue: bigint,
  blockNumber: number,
  priorState: ArmState,
): EvaluationResult {
  if (priorState.phase === "ARMED") {
    if (!enterHolds(observedValue, sub.threshold, sub.comparator)) {
      return { fired: null, nextState: priorState };
    }

    const cooldown = sub.minBlocksBetweenFires;
    if (
      cooldown !== undefined &&
      cooldown > 0 &&
      priorState.lastFiredBlock !== null &&
      blockNumber - priorState.lastFiredBlock < cooldown
    ) {
      // Held, not dropped: the subscription stays armed at the same
      // generation and dispatches at the first sample past the floor.
      return { fired: null, nextState: priorState };
    }

    return {
      fired: {
        subscriptionId: sub.subscriptionId,
        workflowId: sub.workflowId,
        chainId: sub.chainId,
        blockNumber,
        dispatchKey: buildStateDispatchKey(sub, priorState.armGeneration),
        observedValue,
        threshold: sub.threshold,
        comparator: sub.comparator,
      },
      nextState: {
        phase: "FIRED",
        // Held at the arming block so a redelivery rebuilds the same key.
        armGeneration: priorState.armGeneration,
        lastFiredBlock: blockNumber,
      },
    };
  }

  // FIRED: dispatch nothing until the value clears the band, then open a new
  // generation. Re-arming is not itself something a workflow triggers on.
  if (exitHolds(observedValue, sub)) {
    return {
      fired: null,
      nextState: {
        phase: "ARMED",
        armGeneration: blockNumber,
        lastFiredBlock: priorState.lastFiredBlock,
      },
    };
  }
  return { fired: null, nextState: priorState };
}

/**
 * Decode one call's return data to the comparable value, using the output
 * types the subscription carried from its ABI.
 *
 * Returns null rather than throwing when the call reverted, when the data
 * does not match the declared outputs, when the selected output is not a
 * numeric type, or when the index is out of range. The caller skips that
 * subscription for that sample: a decode failure is an absence of
 * observation, and treating it as either "condition holds" or "condition does
 * not hold" would be inventing one.
 */
export function decodeCallResult(
  result: Aggregate3Result,
  outputTypes: string[],
  outputIndex: number,
): bigint | null {
  if (!result.success) {
    return null;
  }
  if (outputIndex < 0 || outputIndex >= outputTypes.length) {
    return null;
  }
  let decoded: ethers.Result;
  try {
    decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      outputTypes,
      result.returnData,
    );
  } catch {
    return null;
  }
  const value: unknown = decoded[outputIndex];
  return typeof value === "bigint" ? value : null;
}
