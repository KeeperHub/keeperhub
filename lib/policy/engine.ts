/**
 * The evaluator: a pure function from (request, compiled policy set) to one
 * decision.
 *
 * No I/O. Loading policy, resolving grants and computing signals all happen
 * outside, so a decision is replayable from a stored fact bundle and testable
 * without a database.
 *
 * Total by construction: every input produces a decision, and any internal
 * failure produces a denial rather than a throw. A caller can never mistake an
 * engine fault for permission.
 */

import { arnStringMatches } from "./arn";
import { clockFacts } from "./clock-facts";
import {
  FactProvenance,
  FactState,
  isSignalConditionKey,
  PolicyDecisionReason,
  PolicyEffect,
  type PolicyEnforcementMode,
  PolicyOperator,
  PolicyOutcome,
} from "./constants";
import { makeDecision, resolveObservedOnly } from "./evaluator";
import { readListFact } from "./fact-resolution";
import { hostMatchesAnyDomain, ipInAnyCidr } from "./network-match";
import { principalFacts } from "./principal-facts";
import type {
  CompiledPolicy,
  CompiledPolicySet,
  CompiledStatement,
  Fact,
  MatchedStatement,
  PolicyCondition,
  PolicyConditionMap,
  PolicyConditionOperand,
  PolicyDecision,
  PolicyFacts,
  PolicyRequest,
  PolicySignalBundle,
  Principal,
} from "./types";
import { CONDITION_GROUP } from "./types";

/**
 * Three-valued match. UNKNOWN is not a third boolean for convenience: it is
 * what makes the fail-closed rule expressible, because an allow and a deny
 * must resolve an undeterminable condition in opposite directions.
 */
const Match = {
  YES: "yes",
  NO: "no",
  UNKNOWN: "unknown",
} as const;

type Match = (typeof Match)[keyof typeof Match];

function factValue<T>(fact: Fact<T> | undefined): {
  state: FactState;
  value?: T;
  provenance?: FactProvenance;
} {
  if (!fact) {
    return { state: FactState.ABSENT };
  }
  if (fact.state === FactState.KNOWN) {
    return {
      state: FactState.KNOWN,
      value: fact.value,
      provenance: fact.provenance,
    };
  }
  return { state: fact.state };
}

function compareNumeric(
  op: PolicyOperator,
  left: string,
  right: PolicyConditionOperand
): Match {
  const a = Number(left);
  const b = Number(right);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return Match.UNKNOWN;
  }
  switch (op) {
    case PolicyOperator.LT:
      return a < b ? Match.YES : Match.NO;
    case PolicyOperator.LTE:
      return a <= b ? Match.YES : Match.NO;
    case PolicyOperator.GT:
      return a > b ? Match.YES : Match.NO;
    case PolicyOperator.GTE:
      return a >= b ? Match.YES : Match.NO;
    default:
      return Match.UNKNOWN;
  }
}

/**
 * The values a fact offers a comparison.
 *
 * A list-backed fact (the assets a call moves, its counterparties, a workflow's
 * tags) resolves to several strings, and they are alternatives rather than a
 * tuple: one asset contributes both its address and its symbol. So a comparison
 * holds when any one of them holds, and a negated comparison holds only when
 * none of them do. Comparing the list itself would stringify it to a
 * comma-joined value that matches nothing, which silently turns an asset or
 * counterparty deny into a no-op.
 */
function comparableValues(left: unknown): unknown[] {
  return Array.isArray(left) ? left : [left];
}

function compareEquality(
  op: PolicyOperator,
  left: unknown,
  right: PolicyConditionOperand
): Match {
  const equal = comparableValues(left).some(
    (value) => String(value) === String(right)
  );
  if (op === PolicyOperator.EQ) {
    return equal ? Match.YES : Match.NO;
  }
  return equal ? Match.NO : Match.YES;
}

const NEGATED_NETWORK_OPERATORS: readonly PolicyOperator[] = [
  PolicyOperator.NOT_IN_CIDR,
  PolicyOperator.NOT_IN_DOMAIN,
];

/**
 * Membership of a network set, by CIDR range or by domain pattern.
 *
 * A value the matcher cannot read never matches, so a malformed rule refuses
 * rather than letting something through. The list must be a list: a single
 * string would silently compare against nothing.
 */
function compareNetwork(
  op: PolicyOperator,
  left: unknown,
  right: PolicyConditionOperand,
  matches: (value: string, patterns: readonly string[]) => boolean
): Match {
  if (!Array.isArray(right)) {
    return Match.UNKNOWN;
  }
  const hit = matches(String(left), right);
  const negated = NEGATED_NETWORK_OPERATORS.includes(op);
  return hit === negated ? Match.NO : Match.YES;
}

function compareMembership(
  op: PolicyOperator,
  left: unknown,
  right: PolicyConditionOperand
): Match {
  if (!Array.isArray(right)) {
    return Match.UNKNOWN;
  }
  const values = comparableValues(left).map((entry) => String(entry));
  // Membership accepts an identifier pattern as well as a literal, so an `in`
  // list holding a wildcard protocol identifier matches the same way a resource
  // pattern does.
  //
  // Deliberately described rather than shown: Tailwind scans source files for
  // class candidates, and a bracketed token whose value contains a slash then
  // two asterisks is read as an arbitrary property. It emits that as a CSS
  // declaration, which opens a comment and silently swallows the rest of the
  // stylesheet, theme tokens included.
  const present = values.some((value) =>
    right.some(
      (candidate) => candidate === value || arnStringMatches(candidate, value)
    )
  );
  if (op === PolicyOperator.IN) {
    return present ? Match.YES : Match.NO;
  }
  return present ? Match.NO : Match.YES;
}

function evaluatePredicate(predicate: PolicyCondition, raw: unknown): Match {
  let result: Match = Match.YES;
  const entries = Object.entries(predicate) as [
    PolicyOperator,
    PolicyConditionOperand,
  ][];
  for (const [op, operand] of entries) {
    let one: Match;
    switch (op) {
      case PolicyOperator.LT:
      case PolicyOperator.LTE:
      case PolicyOperator.GT:
      case PolicyOperator.GTE:
        one = comparableValues(raw).some(
          (value) => compareNumeric(op, String(value), operand) === Match.YES
        )
          ? Match.YES
          : Match.NO;
        break;
      case PolicyOperator.EQ:
      case PolicyOperator.NEQ:
        one = compareEquality(op, raw, operand);
        break;
      case PolicyOperator.IN:
      case PolicyOperator.NOT_IN:
        one = compareMembership(op, raw, operand);
        break;
      case PolicyOperator.IN_CIDR:
      case PolicyOperator.NOT_IN_CIDR:
        one = compareNetwork(op, raw, operand, ipInAnyCidr);
        break;
      case PolicyOperator.IN_DOMAIN:
      case PolicyOperator.NOT_IN_DOMAIN:
        one = compareNetwork(op, raw, operand, hostMatchesAnyDomain);
        break;
      case PolicyOperator.MATCHES:
        one =
          typeof operand === "string" &&
          comparableValues(raw).some((value) =>
            new RegExp(operand).test(String(value))
          )
            ? Match.YES
            : Match.NO;
        break;
      default:
        one = Match.UNKNOWN;
    }
    if (one === Match.NO) {
      return Match.NO;
    }
    if (one === Match.UNKNOWN) {
      result = Match.UNKNOWN;
    }
  }
  return result;
}

/**
 * Map a condition key onto the fact it reads.
 *
 * Facts about the actor are derived from the principal rather than looked up on
 * `facts`, so a caller can neither forget to supply them nor supply a different
 * actor from the one the request is being evaluated for.
 */
function readFact(
  facts: PolicyFacts,
  key: string,
  principal?: Principal
): Fact<unknown> | undefined {
  const derived = principalFacts(principal)[key] ?? clockFacts()[key];
  if (derived) {
    return derived;
  }
  const list = readListFact(facts, key);
  if (list) {
    return list;
  }
  return (facts as unknown as Record<string, Fact<unknown>>)[key];
}

function evaluateSignal(
  signals: PolicySignalBundle | undefined,
  key: string,
  predicate: PolicyCondition
): Match {
  const signal = signals?.[key as keyof PolicySignalBundle];
  if (!signal?.available) {
    // An unavailable signal is unknown, never false. A missing risk score must
    // not read as "not risky".
    return Match.UNKNOWN;
  }
  return evaluatePredicate(predicate, signal.value);
}

/**
 * Whether a statement matches. The provenance rule lives here: a fact the
 * workflow itself produced can never make an allow match, so an attacker who
 * controls upstream data cannot talk the engine into permitting something.
 */
function statementMatches(
  statement: CompiledStatement,
  request: PolicyRequest
): Match {
  if (!statement.capabilities.includes(request.capability)) {
    return Match.NO;
  }

  const isAllow = statement.effect === PolicyEffect.ALLOW;
  let result: Match = Match.YES;

  if (statement.resourcePatterns.length > 0) {
    const resource = factValue(request.facts.resource);
    if (resource.state !== FactState.KNOWN || !resource.value) {
      return Match.UNKNOWN;
    }
    if (isAllow && resource.provenance === FactProvenance.WORKFLOW_DERIVED) {
      // Unvouched. The grant layer is what promotes a resolved template to
      // authoritative; without that promotion it cannot ground a grant.
      return Match.UNKNOWN;
    }
    const hit = statement.resourcePatterns.some((p) =>
      arnStringMatches(p, String(resource.value))
    );
    if (!hit) {
      return Match.NO;
    }
  }

  const conditions = evaluateConditionMap(
    statement.condition,
    request,
    isAllow
  );
  if (conditions === Match.NO) {
    return Match.NO;
  }
  if (conditions === Match.UNKNOWN) {
    result = Match.UNKNOWN;
  }

  return result;
}

/**
 * One condition, three-valued.
 *
 * A fact that is not known is undetermined rather than false, and the caller
 * decides what that means: an allow needs a definite yes, a deny treats
 * undetermined as a hit.
 */
function evaluateOne(
  key: string,
  predicate: PolicyCondition,
  request: PolicyRequest,
  isAllow: boolean
): Match {
  if (isSignalConditionKey(key)) {
    return evaluateSignal(request.signals, key, predicate);
  }
  const fact = factValue(readFact(request.facts, key, request.principal));
  if (fact.state !== FactState.KNOWN) {
    return Match.UNKNOWN;
  }
  if (isAllow && fact.provenance === FactProvenance.WORKFLOW_DERIVED) {
    return Match.UNKNOWN;
  }
  return evaluatePredicate(predicate, fact.value);
}

/**
 * A condition map, with its groups.
 *
 * Plain keys are combined with AND, which is what most rules want. `anyOf` is
 * an either-or, and it is the reason this is recursive: a branch is itself a
 * condition map, so a group can hold a group.
 *
 * The three-valued combination is the part worth stating. An AND is NO if any
 * branch is NO, and undetermined if any is undetermined. An OR is YES if any
 * branch is YES, and only undetermined when nothing said yes and something
 * could not be told. Read the other way round, an OR whose branches are all NO
 * is NO, which is what stops a group quietly widening an allow.
 */
function evaluateConditionMap(
  condition: PolicyConditionMap,
  request: PolicyRequest,
  isAllow: boolean
): Match {
  let result: Match = Match.YES;

  for (const [key, value] of Object.entries(condition)) {
    if (!value) {
      continue;
    }

    let one: Match;
    if (key === CONDITION_GROUP.ANY_OF) {
      one = evaluateAnyOf(
        value as readonly PolicyConditionMap[],
        request,
        isAllow
      );
    } else if (key === CONDITION_GROUP.ALL_OF) {
      one = evaluateAllOf(
        value as readonly PolicyConditionMap[],
        request,
        isAllow
      );
    } else {
      one = evaluateOne(key, value as PolicyCondition, request, isAllow);
    }

    if (one === Match.NO) {
      return Match.NO;
    }
    if (one === Match.UNKNOWN) {
      result = Match.UNKNOWN;
    }
  }

  return result;
}

function evaluateAllOf(
  branches: readonly PolicyConditionMap[],
  request: PolicyRequest,
  isAllow: boolean
): Match {
  let result: Match = Match.YES;
  for (const branch of branches) {
    const one = evaluateConditionMap(branch, request, isAllow);
    if (one === Match.NO) {
      return Match.NO;
    }
    if (one === Match.UNKNOWN) {
      result = Match.UNKNOWN;
    }
  }
  return result;
}

function evaluateAnyOf(
  branches: readonly PolicyConditionMap[],
  request: PolicyRequest,
  isAllow: boolean
): Match {
  // An empty group names no alternative, so nothing satisfies it.
  let result: Match = Match.NO;
  for (const branch of branches) {
    const one = evaluateConditionMap(branch, request, isAllow);
    if (one === Match.YES) {
      return Match.YES;
    }
    if (one === Match.UNKNOWN) {
      result = Match.UNKNOWN;
    }
  }
  return result;
}

/**
 * Resolve a three-valued match against an effect.
 *
 * An allow needs a definite yes: you cannot grant on something you could not
 * determine. A deny treats unknown as a hit: if it cannot be ruled out, refuse.
 * This asymmetry is the fail-closed rule, and it is the only place it lives.
 */
function matchCounts(match: Match, effect: PolicyEffect): boolean {
  if (match === Match.YES) {
    return true;
  }
  if (match === Match.NO) {
    return false;
  }
  return effect !== PolicyEffect.ALLOW;
}

function governs(policy: CompiledPolicy, request: PolicyRequest): boolean {
  if (policy.managedCapabilities.includes(request.capability)) {
    return true;
  }
  const resource = factValue(request.facts.resource);
  if (resource.state !== FactState.KNOWN || !resource.value) {
    return false;
  }
  return policy.managedResourcePatterns.some((p) =>
    arnStringMatches(p, String(resource.value))
  );
}

export function evaluatePolicy(
  request: PolicyRequest,
  policySet: CompiledPolicySet | null
): PolicyDecision {
  const startedAt = Date.now();

  const governing = (policySet?.policies ?? []).filter((p) =>
    governs(p, request)
  );

  if (governing.length === 0) {
    return makeDecision({
      outcome: PolicyOutcome.UNMANAGED,
      reason: PolicyDecisionReason.UNMANAGED,
      policyVersion: policySet?.version ?? null,
      startedAt,
    });
  }

  const observedOnly = resolveObservedOnly(
    governing.map((p) => p.enforcement as PolicyEnforcementMode)
  );
  const governingPolicyIds = governing.map((p) => p.policyId);
  const base = {
    governingPolicyIds,
    observedOnly,
    policyVersion: policySet?.version ?? null,
    startedAt,
  };

  const matched: Record<PolicyEffect, MatchedStatement[]> = {
    [PolicyEffect.ALLOW]: [],
    [PolicyEffect.DENY]: [],
  };

  for (const policy of governing) {
    for (const statement of policy.statements) {
      if (matchCounts(statementMatches(statement, request), statement.effect)) {
        matched[statement.effect].push({
          policyId: policy.policyId,
          sid: statement.sid,
          effect: statement.effect,
        });
      }
    }
  }

  // Deny overrides everything. It is the only effect that is monotonic under
  // adding a policy, which is why a real ceiling has to be written as one.
  if (matched[PolicyEffect.DENY].length > 0) {
    return makeDecision({
      ...base,
      outcome: PolicyOutcome.DENY,
      reason: PolicyDecisionReason.EXPLICIT_DENY,
      matched: matched[PolicyEffect.DENY],
    });
  }

  if (matched[PolicyEffect.ALLOW].length > 0) {
    return makeDecision({
      ...base,
      outcome: PolicyOutcome.ALLOW,
      reason: PolicyDecisionReason.EXPLICIT_ALLOW,
      matched: matched[PolicyEffect.ALLOW],
    });
  }

  // Managed, and nothing permitted it. This is the allowlist behaviour, and the
  // most common cause of a workflow that stops without an obvious reason.
  return makeDecision({
    ...base,
    outcome: PolicyOutcome.DENY,
    reason: PolicyDecisionReason.NO_MATCHING_ALLOW,
  });
}

/** The evaluator, in the shape the guards consume. */
export const POLICY_ENGINE = {
  evaluate: evaluatePolicy,
};
