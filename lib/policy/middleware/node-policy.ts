/**
 * The workflow node middleware: every node checks its own policies before it
 * runs.
 *
 * Shape deliberately mirrors `withStepValueCap`, which already wraps the same
 * set of value-moving steps for the daily spend cap. The wrapper belongs to the
 * node; the plugin body stays unaware a policy engine exists.
 *
 * Placement matters more than it looks. The semantics are "each node verifies
 * itself", but the verification lives in the layer that dispatches nodes rather
 * than inside each action's implementation: there are hundreds of registered
 * steps, and one author forgetting the call would be a hole that fails OPEN.
 * Each action also sees its own config shape, so extraction written per action
 * would be duplicated hundreds of ways instead of living in one table.
 */

import type { Capability } from "../capabilities";
import {
  PolicyCheckpoint,
  PolicyDecisionReason,
  PolicyOutcome,
} from "../constants";
import { PolicyDeniedError } from "../errors";
import {
  failClosedDecision,
  getPolicyEvaluator,
  shouldBlock,
} from "../evaluator";
import type {
  CompiledPolicySet,
  PolicyDecision,
  PolicyFacts,
  PolicySignalBundle,
  Principal,
} from "../types";

/**
 * Everything a node check needs. Assembled by the executor once per node, after
 * that node's templates resolve, because the values a policy cares about do not
 * exist before then.
 */
export type NodePolicyContext = {
  principal: Principal;
  organizationId: string;
  capability: Capability;
  facts: PolicyFacts;
  signals?: PolicySignalBundle;
  /**
   * Compiled once at the start of the run and shared by every node, so a run is
   * never judged half against an old policy and half against a new one. This is
   * an input to evaluation, never the security boundary: the signing-time check
   * reads live policy, so a tightening still takes effect immediately there.
   */
  policySet: CompiledPolicySet | null;
  executionId?: string;
  nodeId?: string;
  workflowId?: string;
  /**
   * Set when an upper layer already decided and reserved for this exact action.
   * Carries the receipt so the lower check consumes it rather than charging a
   * second time.
   */
  decisionReceiptId?: string;
};

export type NodePolicyOutcome<T> =
  | { allowed: true; result: T; decision: PolicyDecision }
  | { allowed: false; decision: PolicyDecision; error: PolicyDeniedError };

/**
 * Evaluate one node without running it. Used by advisory checkpoints and by the
 * simulator, both of which need the verdict but must not cause side effects.
 */
export function evaluateNodePolicy(context: NodePolicyContext): PolicyDecision {
  const startedAt = Date.now();
  try {
    if (!context.organizationId) {
      return failClosedDecision(PolicyDecisionReason.NO_PRINCIPAL, startedAt);
    }
    return getPolicyEvaluator().evaluate(
      {
        principal: context.principal,
        organizationId: context.organizationId,
        capability: context.capability,
        facts: context.facts,
        signals: context.signals,
        checkpoint: PolicyCheckpoint.NODE,
        executionId: context.executionId,
        nodeId: context.nodeId,
        workflowId: context.workflowId,
      },
      context.policySet
    );
  } catch {
    // A fault inside the engine is a denial, never a pass. This is the line
    // that stops a policy-engine bug from becoming an authorization bypass.
    return failClosedDecision(PolicyDecisionReason.ENGINE_ERROR, startedAt);
  }
}

/**
 * Wrap a node's execution in its policy check.
 *
 * Returns a discriminated result rather than throwing, so the executor can turn
 * a denial into a normal failed-node outcome with the right fault domain rather
 * than an unhandled exception that the error classifier would mistake for a
 * platform fault.
 */
export async function withNodePolicy<T>(
  context: NodePolicyContext,
  run: () => Promise<T>
): Promise<NodePolicyOutcome<T>> {
  const decision = evaluateNodePolicy(context);

  if (shouldBlock(decision)) {
    return {
      allowed: false,
      decision,
      error: new PolicyDeniedError({
        reason: decision.reason,
        sid: decision.matched[0]?.sid,
        policyId: decision.matched[0]?.policyId,
        policyVersion: decision.policyVersion,
        correlationId: context.executionId,
      }),
    };
  }

  // A throw from the node itself is the node's failure, not a policy failure,
  // so it propagates untouched. Reservations are settled or released by the
  // caller that owns the ledger, keeping that responsibility in one place.
  const result = await run();
  return { allowed: true, result, decision };
}

/** True when a decision permitted the action. */
export function isAllowedOutcome(decision: PolicyDecision): boolean {
  return (
    decision.outcome === PolicyOutcome.ALLOW ||
    decision.outcome === PolicyOutcome.UNMANAGED
  );
}
