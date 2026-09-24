/**
 * The evaluator contract, and the decision constructors every caller shares.
 *
 * The evaluator is a pure function of (request, compiled policy set, signals).
 * No I/O: loading policy and computing signals happen outside it, so a decision
 * is fully replayable from a stored fact bundle and unit-testable without a
 * database.
 *
 * Until the engine and the policy store land, `UNMANAGED_EVALUATOR` answers
 * every request with "no policy governs this". That makes the guards real and
 * wired now, and inert until there is something to enforce.
 */

import type { Capability } from "./capabilities";
import {
  PolicyEnforcementMode as Mode,
  PolicyDecisionReason,
  type PolicyEnforcementMode,
  PolicyOutcome,
} from "./constants";
import { POLICY_DENIAL_MESSAGE } from "./errors";
import type {
  CompiledPolicySet,
  MatchedStatement,
  PolicyDecision,
  PolicyRequest,
  PolicyReservation,
} from "./types";

/**
 * Evaluates a request against a compiled policy set.
 *
 * Implementations must be total: every input produces a decision, and any
 * internal failure produces a denial rather than throwing, so a caller can never
 * mistake an engine fault for permission.
 */
export type PolicyEvaluator = {
  evaluate(
    request: PolicyRequest,
    policySet: CompiledPolicySet | null
  ): PolicyDecision;
};

type DecisionInit = {
  outcome: PolicyOutcome;
  reason: PolicyDecisionReason;
  matched?: readonly MatchedStatement[];
  governingPolicyIds?: readonly string[];
  reservations?: readonly PolicyReservation[];
  receiptId?: string;
  policyVersion?: string | null;
  observedOnly?: boolean;
  startedAt?: number;
};

/**
 * Build a decision with every field populated. Callers never construct one
 * inline, so a new field is added in exactly one place and cannot be silently
 * omitted at a call site.
 */
export function makeDecision(init: DecisionInit): PolicyDecision {
  const evaluatedAt = Date.now();
  return {
    outcome: init.outcome,
    reason: init.reason,
    matched: init.matched ?? [],
    governingPolicyIds: init.governingPolicyIds ?? [],
    reservations: init.reservations ?? [],
    receiptId: init.receiptId,
    message: POLICY_DENIAL_MESSAGE[init.reason],
    policyVersion: init.policyVersion ?? null,
    observedOnly: init.observedOnly ?? false,
    evaluatedAt,
    durationMs: init.startedAt ? evaluatedAt - init.startedAt : 0,
  };
}

/** No policy claimed this request, so it proceeds untouched. */
export function unmanagedDecision(
  policyVersion: string | null = null,
  startedAt?: number
): PolicyDecision {
  return makeDecision({
    outcome: PolicyOutcome.UNMANAGED,
    reason: PolicyDecisionReason.UNMANAGED,
    policyVersion,
    startedAt,
  });
}

/**
 * A denial the engine produced without consulting any policy: no principal, an
 * unreachable store, or an internal fault. Always fail closed.
 */
export function failClosedDecision(
  reason: PolicyDecisionReason,
  startedAt?: number
): PolicyDecision {
  return makeDecision({
    outcome: PolicyOutcome.DENY,
    reason,
    startedAt,
  });
}

/**
 * True when a decision should stop the action.
 *
 * Monitor mode is handled here rather than at each call site so a guard cannot
 * forget it: an observed-only decision records exactly what it would have done
 * and never blocks. Engine failures block regardless of mode, because "we could
 * not check" is not an observation.
 */
export function shouldBlock(decision: PolicyDecision): boolean {
  if (decision.outcome === PolicyOutcome.ALLOW) {
    return false;
  }
  if (decision.outcome === PolicyOutcome.UNMANAGED) {
    return false;
  }
  if (decision.observedOnly && !isEngineFailureDecision(decision)) {
    return false;
  }
  return true;
}

function isEngineFailureDecision(decision: PolicyDecision): boolean {
  return (
    decision.reason === PolicyDecisionReason.NO_PRINCIPAL ||
    decision.reason === PolicyDecisionReason.STORE_UNAVAILABLE ||
    decision.reason === PolicyDecisionReason.ENGINE_ERROR
  );
}

/**
 * Whether any governing policy is in monitor mode. A request governed by a
 * mixture is treated as observed-only, so introducing a monitor-mode policy can
 * never start blocking traffic that an enforcing policy already permitted.
 */
export function resolveObservedOnly(
  modes: readonly PolicyEnforcementMode[]
): boolean {
  if (modes.length === 0) {
    return false;
  }
  return modes.some((mode) => mode === Mode.MONITOR);
}

/**
 * Placeholder evaluator used until the engine lands.
 *
 * Answers UNMANAGED for every request, which is the correct behaviour while no
 * organization has any policy: nothing is claimed, so nothing is governed. It
 * exists so the guards can be installed, typed and tested now rather than in the
 * same change that introduces enforcement.
 */
export const UNMANAGED_EVALUATOR: PolicyEvaluator = {
  evaluate(_request: PolicyRequest, policySet: CompiledPolicySet | null) {
    return unmanagedDecision(policySet?.version ?? null);
  },
};

/**
 * The evaluator guards use. Indirected through a module-level binding so the
 * engine can replace it in one place, and so tests can substitute a stub without
 * reaching into every call site.
 */
let activeEvaluator: PolicyEvaluator = UNMANAGED_EVALUATOR;

export function getPolicyEvaluator(): PolicyEvaluator {
  return activeEvaluator;
}

export function setPolicyEvaluator(evaluator: PolicyEvaluator): void {
  activeEvaluator = evaluator;
}

export function resetPolicyEvaluator(): void {
  activeEvaluator = UNMANAGED_EVALUATOR;
}

/** Capabilities a policy set governs, used to skip evaluation cheaply. */
export function policySetGoverns(
  policySet: CompiledPolicySet | null,
  capability: Capability
): boolean {
  if (!policySet) {
    return false;
  }
  return policySet.policies.some((policy) =>
    policy.managedCapabilities.includes(capability)
  );
}
