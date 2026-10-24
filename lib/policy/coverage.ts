/**
 * Coverage: which guard dimensions a policy actually binds.
 *
 * A dimension a policy does not name is not enforced. Stating that plainly
 * matters more than it sounds, because the failure is silent: an organization
 * reads its own rule, believes counterparties are constrained, and never finds
 * out that no statement mentions one.
 *
 * The score is only computable because the guard dimensions per capability are
 * a closed enumeration. Without that it would be decoration.
 */

import {
  CAPABILITIES,
  type Capability,
  type GuardDimension,
} from "./capabilities";
import { PolicyConditionKey } from "./constants";
import type { CompiledPolicy, CompiledStatement } from "./types";

/** Which condition keys and statement fields bind which dimension. */
const DIMENSION_SOURCES: Readonly<Record<GuardDimension, readonly string[]>> = {
  asset: [PolicyConditionKey.ASSET],
  counterparty: [
    PolicyConditionKey.COUNTERPARTY,
    PolicyConditionKey.RECIPIENT,
    PolicyConditionKey.SPENDER,
    "__counterparty_patterns__",
  ],
  amount: [
    PolicyConditionKey.USD_VALUE,
    PolicyConditionKey.AMOUNT,
    PolicyConditionKey.UNBOUNDED,
    "__limits__",
  ],
  chain: [PolicyConditionKey.CHAIN_ID, "__resource_patterns__"],
  contract: ["__resource_patterns__"],
  selector: [PolicyConditionKey.SELECTOR, "__resource_patterns__"],
  trigger: [PolicyConditionKey.TRIGGER_TYPE],
  actor: [PolicyConditionKey.ACTOR, PolicyConditionKey.AUTH_METHOD],
  timing: [PolicyConditionKey.TIME_WINDOW, PolicyConditionKey.DAY_OF_WEEK],
  frequency: ["__limits__"],
  gas: [PolicyConditionKey.GAS_PRICE_GWEI, PolicyConditionKey.GAS_LIMIT],
};

function boundKeys(statement: CompiledStatement): Set<string> {
  const keys = new Set<string>(Object.keys(statement.condition));
  if (statement.resourcePatterns.length > 0) {
    keys.add("__resource_patterns__");
  }
  if (statement.counterpartyPatterns.length > 0) {
    keys.add("__counterparty_patterns__");
  }
  if (statement.limits.length > 0) {
    keys.add("__limits__");
  }
  return keys;
}

export type CapabilityCoverage = {
  capability: Capability;
  bound: readonly GuardDimension[];
  unbound: readonly GuardDimension[];
  /** Whole percent of this capability's dimensions the policy names. */
  score: number;
};

export type PolicyCoverage = {
  policyId: string;
  /** Whole percent across every capability the policy governs. */
  score: number;
  perCapability: readonly CapabilityCoverage[];
};

export function scorePolicy(policy: CompiledPolicy): PolicyCoverage {
  const perCapability: CapabilityCoverage[] = [];

  for (const capability of policy.managedCapabilities) {
    const dimensions = (CAPABILITIES[capability]?.guardDimensions ??
      []) as readonly GuardDimension[];
    if (dimensions.length === 0) {
      continue;
    }

    // Only statements that actually apply to this capability count toward it.
    // A rule about transfers says nothing about how well borrowing is bounded.
    const relevant = policy.statements.filter((s) =>
      s.capabilities.includes(capability)
    );
    const keys = new Set<string>();
    for (const statement of relevant) {
      for (const key of boundKeys(statement)) {
        keys.add(key);
      }
    }

    const bound: GuardDimension[] = [];
    const unbound: GuardDimension[] = [];
    for (const dimension of dimensions) {
      const sources = DIMENSION_SOURCES[dimension] ?? [];
      if (sources.some((source) => keys.has(source))) {
        bound.push(dimension);
      } else {
        unbound.push(dimension);
      }
    }

    perCapability.push({
      capability,
      bound,
      unbound,
      score: Math.round((bound.length / dimensions.length) * 100),
    });
  }

  const score =
    perCapability.length === 0
      ? 0
      : Math.round(
          perCapability.reduce((sum, c) => sum + c.score, 0) /
            perCapability.length
        );

  return { policyId: policy.policyId, score, perCapability };
}
