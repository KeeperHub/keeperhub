import type { ethers } from "ethers";

/**
 * Local copy of the canonical Multicall3 address/ABI slice this module
 * needs (aggregate3 only). `@techops/events-tracker` is a standalone
 * package (`rootDir: "."`, `include: ["src/**", "lib/**"]` scoped to this
 * package's own `lib/`) and cannot resolve modules from the monorepo root's
 * `lib/contracts/multicall3.ts` - the same constraint `in-flight.ts` already
 * documents for its copy of the executor's InFlightTracker. Deployment
 * verified across all 11 CHAIN_CONFIG mainnets via direct eth_getCode calls,
 * see the follow-up comment on issue #2240.
 */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const AGGREGATE3_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
        name: "calls",
        type: "tuple[]",
      },
    ],
    name: "aggregate3",
    outputs: [
      {
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
        name: "returnData",
        type: "tuple[]",
      },
    ],
    stateMutability: "payable",
    type: "function",
  },
] as const;

/**
 * Core evaluation logic for issue #2240 - "Workflows cannot trigger on a
 * threshold over contract state, only on emitted events".
 *
 * This module is deliberately free of any provider/subscription wiring: it
 * takes decoded `eth_call` results in and produces ARMED/FIRED transitions
 * out, so it can be unit tested without a live chain and plugged into
 * `ChainProviderManager`'s existing per-block hook once the maintainers
 * confirm the design (see the two design-proposal comments on the issue).
 *
 * Design recap (per the issue's own request to settle these before code):
 *  - Dedup identity: (subscriptionId, blockNumber). A per-block eth_call
 *    result is uniquely identified by which subscription asked and which
 *    block it was evaluated against - this reuses the same block-scoped
 *    reasoning the event-tracker already applies for reorgs, rather than
 *    inventing a new key space.
 *  - Edge detection: fire only on the transition from "not armed" to
 *    "condition holds" (false -> true), not on every block the condition
 *    continues to hold. State is a single persisted boolean per subscription
 *    (`armed`), so a restart with no prior state treats the first observed
 *    "true" as an edge (fail-safe: a workflow author expects the first
 *    breach to fire, not to be silently swallowed because the process
 *    doesn't remember a "before" state).
 *  - Hysteresis / re-arm: an optional `clearThreshold`, asymmetric from the
 *    fire `threshold`, so a value oscillating right at the boundary does not
 *    produce a burst of fire/re-arm/fire cycles. Without `clearThreshold`
 *    the re-arm condition is simply "no longer past `threshold`" (no
 *    hysteresis band), which is the correct default for a strictly
 *    monotonic comparator like "balance below Y".
 */

export type ThresholdComparator = "lt" | "lte" | "gt" | "gte";

export interface StateThresholdSubscription {
  subscriptionId: string;
  workflowId: string;
  chainId: number;
  /** Contract to eth_call against. */
  contractAddress: string;
  /** ABI-encoded calldata for the view function (already encoded by the
   * builder layer - this module does not know about function signatures). */
  callData: string;
  /** Decoded numeric value is compared against this threshold. */
  threshold: bigint;
  comparator: ThresholdComparator;
  /**
   * Optional distinct re-arm boundary. When set, once FIRED the
   * subscription only re-arms after the value crosses back past
   * `clearThreshold` (which must be on the "safe" side of `threshold`),
   * not merely past `threshold` itself. Undefined means no hysteresis band:
   * the re-arm condition is the exact negation of the fire condition.
   */
  clearThreshold?: bigint;
}

/** Persisted per-subscription state - the only thing that must survive a
 * restart for edge detection to behave correctly across a process bounce. */
export interface SubscriptionArmState {
  /**
   * true: condition observed as met at least once and not yet cleared, i.e.
   * either currently FIRED-and-not-rearmed or mid-hysteresis-band.
   *
   * Naming: "armed" here means "the guard that prevents a duplicate fire is
   * up", not "will fire on next check" - the issue's own vocabulary ("armed
   * / fired") is a state name, not a predicate, so this field mirrors that
   * rather than introducing a second name for the same concept.
   */
  armed: boolean;
}

export interface EvaluationResult {
  /** Present only when this evaluation should dispatch a workflow trigger. */
  fired: {
    subscriptionId: string;
    workflowId: string;
    chainId: number;
    blockNumber: number;
    /** Dedup key per the design above - (subscriptionId, blockNumber). */
    dedupKey: string;
    observedValue: bigint;
  } | null;
  /** The state to persist for this subscription after this evaluation,
   * regardless of whether it fired. Callers must persist this before the
   * next block's evaluation runs for the same subscription, or a crash
   * between evaluation and persistence re-observes the same edge next block
   * and fires twice - the same best-effort trade-off the existing Redis
   * dedup store already makes for event-based triggers (see dedup.ts). */
  nextState: SubscriptionArmState;
}

function comparatorHolds(
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

/** The comparator that must hold for a FIRED subscription to re-arm, given
 * the fire comparator. Without a `clearThreshold` this is the exact
 * negation of `comparatorHolds` above; with one, it is evaluated against
 * `clearThreshold` instead of `threshold`. */
function invertComparator(comparator: ThresholdComparator): ThresholdComparator {
  switch (comparator) {
    case "lt":
      return "gte";
    case "lte":
      return "gt";
    case "gt":
      return "lte";
    case "gte":
      return "lt";
  }
}

/**
 * Pure evaluation step - no I/O. Called once per block per subscription
 * with the already-decoded `eth_call` result for that block.
 */
export function evaluateThreshold(
  sub: StateThresholdSubscription,
  observedValue: bigint,
  blockNumber: number,
  priorState: SubscriptionArmState,
): EvaluationResult {
  const holds = comparatorHolds(observedValue, sub.threshold, sub.comparator);

  if (!priorState.armed) {
    if (!holds) {
      // Condition not met, and we were not armed: nothing to do.
      return { fired: null, nextState: { armed: false } };
    }
    // Edge: false -> true. Fire, and become armed so the next block that
    // still holds does not fire again.
    return {
      fired: {
        subscriptionId: sub.subscriptionId,
        workflowId: sub.workflowId,
        chainId: sub.chainId,
        blockNumber,
        dedupKey: `state:${sub.subscriptionId}:${blockNumber}`,
        observedValue,
      },
      nextState: { armed: true },
    };
  }

  // Already armed (fired and not yet re-armed). Check whether the re-arm
  // boundary has been crossed. With no clearThreshold, re-arm is simply
  // "condition no longer holds". With one, re-arm requires crossing back
  // past clearThreshold specifically (hysteresis band).
  const rearmThreshold = sub.clearThreshold ?? sub.threshold;
  const rearmComparator = invertComparator(sub.comparator);
  const rearms = comparatorHolds(observedValue, rearmThreshold, rearmComparator);

  if (rearms) {
    // Crossed back to safe territory: re-arm, but do not fire (re-arming
    // is not itself an event a workflow should trigger on).
    return { fired: null, nextState: { armed: false } };
  }

  // Still in breach (or still inside the hysteresis band): stay armed,
  // do not re-fire.
  return { fired: null, nextState: { armed: true } };
}

/**
 * Batches several subscriptions' eth_call requests into one Multicall3
 * aggregate3 call, so the marginal on-chain cost is one RPC round-trip per
 * block regardless of how many state-threshold subscriptions are active on
 * that chain - matching the issue's stated cost target ("one RPC call per
 * block per subscription" become "one RPC call per block per BATCH", an
 * improvement over the issue's own floor).
 *
 * `allowFailure: true` on every call so one subscription's revert (e.g. a
 * contract that reverts a view function under some conditions) does not
 * poison the batch for every other subscription sharing the block.
 */
export function buildMulticallPayload(
  calls: Array<{ contractAddress: string; callData: string }>,
): { target: string; abi: unknown; args: unknown[] } {
  return {
    target: MULTICALL3_ADDRESS,
    abi: AGGREGATE3_ABI,
    args: [
      calls.map((c) => ({
        target: c.contractAddress,
        allowFailure: true,
        callData: c.callData,
      })),
    ],
  };
}

/**
 * Decode a single aggregate3 result slot. Returns null (rather than
 * throwing) when the call reverted (`success === false`) or the
 * `returnData` cannot be decoded as a single uint256/int256 - the caller
 * should skip evaluation for that subscription on that block rather than
 * treat a decode failure as "condition holds" or "condition does not hold".
 */
export function decodeAggregate3Result(
  result: { success: boolean; returnData: string },
  abiCoder: ethers.AbiCoder,
): bigint | null {
  if (!result.success) {
    return null;
  }
  try {
    const [decoded] = abiCoder.decode(["uint256"], result.returnData);
    return decoded as bigint;
  } catch {
    try {
      const [decoded] = abiCoder.decode(["int256"], result.returnData);
      return decoded as bigint;
    } catch {
      return null;
    }
  }
}
