import "server-only";

/**
 * The control-plane guardrail: policy over what people and agents may CHANGE.
 *
 * Without this the data plane is decorative. A rule saying "only send to known
 * counterparties" is worth nothing if any member can add a counterparty, and
 * any rule at all is worth nothing if whoever it constrains can edit it.
 *
 * One helper, called from a mutating route after its own role check. Policy is
 * evaluated last on purpose: a policy allow is never reached for a request the
 * role model already refused, which makes "policy can only subtract, never
 * grant" a property of control flow rather than a convention.
 */

import { NextResponse } from "next/server";
import { buildResourceArn } from "./arn";
import type { Capability } from "./capabilities";
import { enforcePolicy } from "./guard";
import {
  type ArnSegment,
  FactProvenance,
  FactState,
  PolicyCheckpoint,
  type PolicyRole,
  PrincipalKind,
} from "./index";
import type { PolicyFacts } from "./types";

const UNKNOWN = { state: FactState.UNKNOWN } as const;

export type ControlPlaneCheck = {
  organizationId: string;
  userId: string;
  role: PolicyRole;
  capability: Capability;
  /** The object being changed, when there is one. */
  resource?: { type: ArnSegment; id: string };
  /**
   * The project the action targets.
   *
   * The only scope a creation can be narrowed by: the thing being created has
   * no id yet, so "who may create a workflow" is answerable as "where".
   */
  projectId?: string;
  /** Tags carried by the object being changed. */
  tags?: readonly string[];
  /**
   * The IP the request came from.
   *
   * Ambient, so a rule limiting the organization to an office network is one
   * statement rather than one per capability.
   */
  sourceIp?: string;
  authMethod?: "oauth" | "api-key" | "session";
  apiKeyId?: string;
};

function controlPlaneFacts(check: ControlPlaneCheck): PolicyFacts {
  const resource = check.resource
    ? buildResourceArn(check.resource.type, check.resource.id)
    : null;
  return {
    capability: check.capability,
    // A control-plane target comes from the route's own path, not from
    // workflow data, so it is authoritative.
    resource: resource
      ? {
          state: FactState.KNOWN,
          value: resource,
          provenance: FactProvenance.AUTHORITATIVE,
        }
      : UNKNOWN,
    chainId: UNKNOWN,
    contractAddress: UNKNOWN,
    selector: UNKNOWN,
    protocolSlug: UNKNOWN,
    assets: UNKNOWN,
    counterparties: UNKNOWN,
    nativeValueWei: UNKNOWN,
    usdValue: UNKNOWN,
    unbounded: UNKNOWN,
    gasPriceGwei: UNKNOWN,
    gasLimit: UNKNOWN,
    signerMode: UNKNOWN,
    triggerType: UNKNOWN,
    workflowId: UNKNOWN,
    workflowTags: check.tags
      ? {
          state: FactState.KNOWN,
          value: check.tags,
          provenance: FactProvenance.AUTHORITATIVE,
        }
      : UNKNOWN,
    projectId: check.projectId
      ? {
          state: FactState.KNOWN,
          value: check.projectId,
          provenance: FactProvenance.AUTHORITATIVE,
        }
      : UNKNOWN,
    sourceIp: check.sourceIp
      ? {
          state: FactState.KNOWN,
          value: check.sourceIp,
          provenance: FactProvenance.AUTHORITATIVE,
        }
      : UNKNOWN,
    httpHost: UNKNOWN,
    httpUrl: UNKNOWN,
    httpMethod: UNKNOWN,
    resourceId: check.resource
      ? {
          state: FactState.KNOWN,
          value: check.resource.id,
          provenance: FactProvenance.AUTHORITATIVE,
        }
      : UNKNOWN,
  };
}

/**
 * Check a control-plane mutation.
 *
 * Returns a ready response on refusal so a route stays a one-liner, and null
 * when the action may proceed. Call it after the role check, never before.
 */
/**
 * The principal, in the shape the engine expects for its kind.
 *
 * A member carries a user id, an API key carries its own id, and both carry the
 * organization and the role. Building it here keeps the union honest rather
 * than casting at the call site.
 */
function toPrincipal(
  check: ControlPlaneCheck
): Parameters<typeof enforcePolicy>[0]["principal"] {
  if (check.authMethod === "api-key") {
    return {
      kind: PrincipalKind.API_KEY,
      apiKeyId: check.apiKeyId ?? "unknown",
      organizationId: check.organizationId,
      role: check.role,
    };
  }
  if (check.authMethod === "oauth") {
    return {
      kind: PrincipalKind.OAUTH,
      userId: check.userId,
      organizationId: check.organizationId,
      role: check.role,
      scope: "",
    };
  }
  return {
    kind: PrincipalKind.MEMBER,
    userId: check.userId,
    organizationId: check.organizationId,
    role: check.role,
  };
}

/**
 * The verdict, without a transport shape.
 *
 * The route helpers return a ready `NextResponse`, but the shared auth
 * resolvers return their own refusal type, so the decision has to be available
 * on its own for the gate that runs inside them.
 */
export async function decideControlPlane(
  check: ControlPlaneCheck
): Promise<{ blocked: boolean; message?: string; reason: string }> {
  const verdict = await enforcePolicy({
    principal: toPrincipal(check),
    organizationId: check.organizationId,
    capability: check.capability,
    facts: controlPlaneFacts(check),
    checkpoint: PolicyCheckpoint.CONTROL_PLANE,
    // Control-plane objects are not grant-scoped: reaching them is decided by
    // role, and what may be done with them is decided by policy.
  });

  return {
    blocked: verdict.blocked,
    message: verdict.decision.message ?? undefined,
    reason: verdict.decision.reason,
  };
}

export async function enforceControlPlane(
  check: ControlPlaneCheck
): Promise<NextResponse | null> {
  const verdict = await decideControlPlane(check);
  if (!verdict.blocked) {
    return null;
  }

  return NextResponse.json(
    {
      error: verdict.message ?? "Blocked by an organization policy",
      code: "policy_denied",
      reason: verdict.reason,
    },
    { status: 403 }
  );
}
