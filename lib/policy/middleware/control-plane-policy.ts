/**
 * The control-plane middleware: policy over what members and agents may CHANGE
 * about the organization, not just what workflows do onchain.
 *
 * Without this the data plane is decorative. A rule saying "only send to address
 * book entries" is worth nothing if any member can add an entry, and any rule at
 * all is worth nothing if whoever it constrains can edit it.
 *
 * Policy is evaluated AFTER the role floor, never before. That ordering is what
 * makes "policy can only subtract, never grant" a property of control flow
 * rather than a convention: a policy allow is never reached for a request the
 * role model already refused.
 */

import type { Capability } from "../capabilities";
import {
  POLICY_ROLE_RANK,
  PolicyCheckpoint,
  PolicyDecisionReason,
  type PolicyRole,
  PrincipalKind,
} from "../constants";
import {
  failClosedDecision,
  getPolicyEvaluator,
  shouldBlock,
} from "../evaluator";
import type {
  CompiledPolicySet,
  PolicyDecision,
  PolicyFacts,
  PolicyGuardResult,
  Principal,
} from "../types";

/**
 * Capabilities that grant authority over the policy system itself.
 *
 * These need loud handling rather than uniform treatment. Uniformity is exactly
 * the trap that makes a single careless grant a silent privilege escalation: if
 * every capability is treated the same, a rule permitting "change organization
 * settings" quietly permits "rewrite the rules that constrain me".
 */
export const SELF_REFERENTIAL_CAPABILITY_PREFIXES: readonly string[] = [
  "policy.",
  "member.",
  "apikey.",
  "addressbook.",
  "wallet.role.",
] as const;

export function isSelfReferentialCapability(capability: string): boolean {
  return SELF_REFERENTIAL_CAPABILITY_PREFIXES.some((prefix) =>
    capability.startsWith(prefix)
  );
}

/** Minimum role a capability requires before policy is even consulted. */
export type RoleFloor = PolicyRole | "none";

export type ControlPlaneContext = {
  principal: Principal;
  organizationId: string;
  capability: Capability;
  /** Facts about the resource being changed, for conditional rules. */
  facts: PolicyFacts;
  policySet: CompiledPolicySet | null;
  /** Role required before policy runs. Policy cannot grant below this. */
  roleFloor?: RoleFloor;
};

/**
 * The role a principal holds, or null when it carries none.
 *
 * Service and platform principals have no organization role by construction:
 * they are the platform acting on its own behalf, governed by deployment
 * controls rather than by customer policy.
 */
export function principalRole(principal: Principal): PolicyRole | null {
  switch (principal.kind) {
    case PrincipalKind.MEMBER:
    case PrincipalKind.API_KEY:
    case PrincipalKind.OAUTH:
      return principal.role;
    default:
      return null;
  }
}

export function principalOrganizationId(principal: Principal): string | null {
  switch (principal.kind) {
    case PrincipalKind.MEMBER:
    case PrincipalKind.API_KEY:
    case PrincipalKind.OAUTH:
      return principal.organizationId;
    default:
      return null;
  }
}

/**
 * Whether a role satisfies a floor. An unrecognised role ranks as undefined and
 * fails, which is the intended behaviour for a column with no database-level
 * constraint.
 */
export function satisfiesRoleFloor(
  role: PolicyRole | null,
  floor: RoleFloor
): boolean {
  if (floor === "none") {
    return true;
  }
  if (!role) {
    return false;
  }
  const held = POLICY_ROLE_RANK[role];
  const required = POLICY_ROLE_RANK[floor];
  if (held === undefined || required === undefined) {
    return false;
  }
  return held >= required;
}

/**
 * Evaluate a control-plane mutation.
 *
 * Returns a guard result rather than a response, so the caller owns its own wire
 * format and this stays usable from a route handler, a server action and the
 * simulator alike.
 */
export function evaluateControlPlanePolicy(
  context: ControlPlaneContext
): PolicyDecision {
  const startedAt = Date.now();

  try {
    const orgId = principalOrganizationId(context.principal);
    if (!orgId || orgId !== context.organizationId) {
      return failClosedDecision(PolicyDecisionReason.NO_PRINCIPAL, startedAt);
    }

    return getPolicyEvaluator().evaluate(
      {
        principal: context.principal,
        organizationId: context.organizationId,
        capability: context.capability,
        facts: context.facts,
        checkpoint: PolicyCheckpoint.CONTROL_PLANE,
      },
      context.policySet
    );
  } catch {
    return failClosedDecision(PolicyDecisionReason.ENGINE_ERROR, startedAt);
  }
}

/**
 * Full control-plane gate: role floor first, then policy.
 *
 * The order is the point. A policy `allow` can never rescue a request the role
 * model refused, so policy is structurally incapable of granting.
 */
export function enforceControlPlanePolicy(
  context: ControlPlaneContext
): PolicyGuardResult {
  const floor = context.roleFloor ?? "none";
  const role = principalRole(context.principal);

  if (!satisfiesRoleFloor(role, floor)) {
    return {
      blocked: true,
      decision: failClosedDecision(PolicyDecisionReason.NO_PRINCIPAL),
    };
  }

  const decision = evaluateControlPlanePolicy(context);
  return shouldBlock(decision)
    ? { blocked: true, decision }
    : { blocked: false, decision };
}
