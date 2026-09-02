/**
 * The policy denial error.
 *
 * A denial is the organization's guardrail working, not a platform fault, so it
 * carries its fault domain STRUCTURALLY rather than relying on the message
 * classifier to infer it. That matters because the classifier is regex over the
 * error string and defaults an unmatched message to a system failure so real
 * engine faults still page. Left to the default, every policy denial in
 * production would look like an outage.
 *
 * Kept dependency-free so it is safe to throw from `"use step"` plugin files and
 * from the standalone executor process.
 */

import {
  isEngineFailureReason,
  type PolicyDecisionReason,
  PolicyDecisionReason as Reason,
} from "./constants";

/**
 * User-facing messages, keyed by reason. Deliberately vague about which rule
 * matched: a denial should not become an oracle for probing the policy set.
 * The decision log carries the detail for anyone entitled to see it.
 */
export const POLICY_DENIAL_MESSAGE: Readonly<
  Record<PolicyDecisionReason, string>
> = {
  [Reason.UNMANAGED]: "Allowed. No policy governs this action.",
  [Reason.EXPLICIT_DENY]: "Blocked by an organization policy.",
  [Reason.EXPLICIT_ALLOW]: "Allowed by an organization policy.",
  [Reason.NO_MATCHING_ALLOW]:
    "Blocked by an organization policy: this action is governed but not permitted.",
  [Reason.LIMIT_EXCEEDED]:
    "Blocked by an organization policy: a spending or rate limit has no remaining allowance.",
  [Reason.FACT_UNRESOLVED]:
    "Blocked by an organization policy: this action could not be checked against the policy that governs it.",
  // Not a rule refusing something, a resource that was never handed over. The
  // fix is a grant, not a policy edit, so the message says so.
  [Reason.NOT_GRANTED]:
    "Blocked: this workflow has not been given access to that resource.",
  [Reason.NO_PRINCIPAL]:
    "Blocked: the organization could not be determined for this request.",
  [Reason.STORE_UNAVAILABLE]:
    "Blocked: the policy service is unavailable, so this action cannot be authorized.",
  [Reason.ENGINE_ERROR]: "Blocked: the policy check could not be completed.",
} as const;

export type PolicyDeniedErrorInit = {
  reason: PolicyDecisionReason;
  /** Statement that produced the denial, when there was one. */
  sid?: string;
  policyId?: string;
  policyVersion?: string | null;
  correlationId?: string;
};

/**
 * Thrown by guards that must interrupt execution rather than return a result.
 *
 * `retryable` is false by design: a policy denial is a decision, not a transient
 * failure, and retrying it wastes gas and clutters the log.
 */
export class PolicyDeniedError extends Error {
  override readonly name = "PolicyDeniedError" as const;
  readonly reason: PolicyDecisionReason;
  readonly sid?: string;
  readonly policyId?: string;
  readonly policyVersion: string | null;
  readonly correlationId?: string;
  readonly retryable = false as const;

  constructor(init: PolicyDeniedErrorInit) {
    super(POLICY_DENIAL_MESSAGE[init.reason]);
    this.reason = init.reason;
    this.sid = init.sid;
    this.policyId = init.policyId;
    this.policyVersion = init.policyVersion ?? null;
    this.correlationId = init.correlationId;
  }

  /**
   * Redacted, user-safe text. Never leaks policy internals, matched statement
   * identifiers, or infrastructure detail.
   */
  toUserMessage(): string {
    return POLICY_DENIAL_MESSAGE[this.reason];
  }

  /**
   * True when the denial came from the engine failing rather than a policy
   * refusing. Operationally distinct: a spike in these is an incident, a spike
   * in ordinary denials is a customer tightening their rules.
   */
  isEngineFailure(): boolean {
    return isEngineFailureReason(this.reason);
  }
}

export function isPolicyDeniedError(
  error: unknown
): error is PolicyDeniedError {
  return error instanceof PolicyDeniedError;
}

/**
 * Wrap an arbitrary throw into a denial.
 *
 * The single most important line in the engine: any unexpected exception
 * anywhere inside a guard becomes a denial rather than propagating as an
 * ordinary error that a caller might treat as non-fatal. A bug in the policy
 * engine must never become an allow.
 */
export function toPolicyDenial(
  error: unknown,
  correlationId?: string
): PolicyDeniedError {
  if (isPolicyDeniedError(error)) {
    return error;
  }
  return new PolicyDeniedError({
    reason: Reason.ENGINE_ERROR,
    correlationId,
  });
}

/**
 * Where an organization changes the rule that refused an action.
 *
 * Absolute, matching the quota and payment notices, because a denial is read
 * outside the app as often as inside it: in an execution log, an email, an
 * agent's reply or a CLI transcript. A path alone is only clickable in one of
 * those places.
 */
export function policyPageLink(input: {
  organizationId: string;
  /** Included only where the reader is already known to be allowed to see it. */
  policyId?: string;
  sid?: string;
}): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";
  const base = `${appUrl}/settings/${input.organizationId}/policies`;
  if (!input.policyId) {
    return base;
  }
  const params = new URLSearchParams({ policy: input.policyId });
  if (input.sid) {
    params.set("rule", input.sid);
  }
  return `${base}?${params.toString()}`;
}

/**
 * The denial whoever ran the workflow reads.
 *
 * Says why, and where to look. It says nothing about which rule decided, and
 * that is deliberate: reading policy is limited to admins and owners, while any
 * member can run a workflow, so the denial must not become a way around that
 * permission. A statement name is written by the author and routinely carries
 * the thing it bounds, so "Rule: max-100k-usdc-to-treasury" discloses the cap
 * as surely as printing the number would.
 *
 * The deciding statement is still recorded on the decision, which the policy
 * page reads under the same admin check. Someone allowed to see which rule
 * fired can see it there.
 */
export function explainDenial(input: {
  reason: PolicyDecisionReason;
  organizationId?: string;
}): string {
  // No URL in the text. This string is written to a step, a log line and an
  // API response, and one of those paths strips every URL from a web3 step's
  // error because a URL there is normally an RPC endpoint. The reader was left
  // with a redaction placeholder where the help was meant to be. The reader
  // also cannot click a sentence, so where to go belongs in the surface showing
  // the failure, next to a link it can actually render.
  return POLICY_DENIAL_MESSAGE[input.reason];
}

/**
 * Whether this text is one of the refusals above.
 *
 * The messages are a closed set this module owns, so a caller showing a failed
 * step can tell a policy refusal from any other error without guessing at the
 * wording, and offer the way to the rules that caused it.
 */
export function isPolicyDenialMessage(
  text: string | null | undefined
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  return Object.values(POLICY_DENIAL_MESSAGE).some(
    (message) => message === trimmed
  );
}
