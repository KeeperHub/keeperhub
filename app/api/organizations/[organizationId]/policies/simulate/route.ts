import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import {
  type Capability,
  type Fact,
  FactProvenance,
  FactState,
  isCapability,
  PolicyCheckpoint,
  type PolicyFacts,
  PolicyRole,
  PrincipalKind,
  shouldBlock,
} from "@/lib/policy";
import { evaluatePolicy } from "@/lib/policy/engine";
import { getCompiledPolicySet } from "@/lib/policy/store";
import type { Principal } from "@/lib/policy/types";
import { requireOrgPolicyAccess } from "../_lib/access";

/**
 * Answer "what would happen if I did this", without doing it.
 *
 * This is what makes turning enforcement on safe: an author can see the verdict
 * and the statement that produced it before any workflow depends on it. It is
 * also the fastest way to find the usual authoring mistake, which is claiming a
 * scope and forgetting to grant anything back inside it.
 *
 * Read access, because it evaluates rather than changes anything, and an admin
 * who can see policy can already see what it says.
 */

const UNKNOWN = { state: FactState.UNKNOWN } as const;

function toFact<T>(
  value: T | undefined | null,
  provenance: FactProvenance
): Fact<T> {
  if (value === undefined || value === null || value === "") {
    return UNKNOWN;
  }
  return { state: FactState.KNOWN, value, provenance };
}

/** Decimal native figure to wei, or undefined when it is not a number. */
function toWei(amount: string): string | undefined {
  try {
    return ethers.parseEther(amount).toString();
  } catch {
    return undefined;
  }
}

/**
 * Prefixes the identity of a role-only simulation. Not a member id, so a rule
 * naming a person cannot match it.
 */
const SIMULATED_ROLE_PREFIX = "simulated-role:";

type SimulateNode = {
  nodeId?: string;
  capability?: string;
  resource?: string;
  usdValue?: string;
  /** Amount in an asset's own units, when the rule is not denominated in dollars. */
  amount?: string;
  /** Amount of the chain's own currency, as a decimal figure. */
  nativeAmount?: string;
  /** The asset identifier an amount is counted in. */
  asset?: string;
  chainId?: number;
  selector?: string;
  triggerType?: string;
  unbounded?: boolean;
  /**
   * Whether the resource arrived through workflow data rather than from a
   * grant. Simulating this is the point: it shows an author why a templated
   * target behaves differently from a fixed one.
   */
  workflowDerived?: boolean;
};

function buildFacts(node: SimulateNode, capability: Capability): PolicyFacts {
  const provenance = node.workflowDerived
    ? FactProvenance.WORKFLOW_DERIVED
    : FactProvenance.AUTHORITATIVE;
  return {
    capability,
    resource: toFact(node.resource, provenance),
    chainId: toFact(node.chainId, FactProvenance.AUTHORITATIVE),
    contractAddress: UNKNOWN,
    selector: toFact(node.selector, FactProvenance.AUTHORITATIVE),
    protocolSlug: UNKNOWN,
    // A simulated amount denominated in a token becomes a one-asset fact, so a
    // rule written against that asset binds exactly as it would at run time.
    assets: node.asset
      ? {
          state: FactState.KNOWN,
          value: [{ address: node.asset, amount: node.amount }],
          provenance,
        }
      : UNKNOWN,
    counterparties: UNKNOWN,
    nativeValueWei: toFact(
      node.nativeAmount ? toWei(node.nativeAmount) : undefined,
      provenance
    ),
    usdValue: toFact(node.usdValue, provenance),
    unbounded: toFact(node.unbounded, FactProvenance.AUTHORITATIVE),
    gasPriceGwei: UNKNOWN,
    gasLimit: UNKNOWN,
    signerMode: UNKNOWN,
    triggerType: toFact(node.triggerType, FactProvenance.AUTHORITATIVE),
    workflowId: UNKNOWN,
    workflowTags: UNKNOWN,
    projectId: UNKNOWN,
    sourceIp: UNKNOWN,
    httpHost: UNKNOWN,
    httpUrl: UNKNOWN,
    httpMethod: UNKNOWN,
    resourceId: UNKNOWN,
  };
}

/**
 * Who the simulation runs as.
 *
 * Simulating a bare role must not borrow the viewer's identity: a rule naming
 * one person would then match whoever happened to be looking at the page, and
 * the answer would be right for them and wrong for everyone else. A role with
 * no person carries an identity that matches no member.
 */
function simulatedPrincipal(input: {
  organizationId: string;
  actorId?: string;
  actorRole?: string;
  viewerId: string;
  viewerRole?: PolicyRole | null;
}): Principal {
  const role =
    (input.actorRole as PolicyRole | undefined) ??
    input.viewerRole ??
    PolicyRole.MEMBER;

  return {
    kind: PrincipalKind.MEMBER,
    userId:
      input.actorId ??
      (input.actorRole ? `${SIMULATED_ROLE_PREFIX}${role}` : input.viewerId),
    organizationId: input.organizationId,
    role,
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<Response> {
  const { organizationId } = await context.params;
  const access = await requireOrgPolicyAccess(request, organizationId, "read");
  if (!access.ok) {
    return access.response;
  }

  const body = (await request.json().catch(() => null)) as {
    nodes?: SimulateNode[];
    /** Who to simulate as. Defaults to the viewer. */
    actorId?: string;
    actorRole?: string;
  } | null;
  const nodes = body?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return NextResponse.json(
      { error: "Provide a `nodes` array describing the actions to simulate" },
      { status: 400 }
    );
  }

  try {
    const policySet = await getCompiledPolicySet(organizationId);

    const results = nodes.map((node, index) => {
      const capability = node.capability;
      if (!(capability && isCapability(capability))) {
        return {
          nodeId: node.nodeId ?? `node-${index}`,
          error: `Unknown capability "${capability ?? ""}"`,
        };
      }
      const decision = evaluatePolicy(
        {
          // Simulating always as the viewer would make every control-plane
          // question unanswerable: "may Cleo create an API key" is the whole
          // point, and the viewer is an admin or owner by definition of having
          // reached this page.
          principal: simulatedPrincipal({
            organizationId,
            actorId: body?.actorId,
            actorRole: body?.actorRole,
            viewerId: access.userId,
            viewerRole: access.role,
          }),
          organizationId,
          capability,
          facts: buildFacts(node, capability),
          checkpoint: PolicyCheckpoint.AUTHORING,
        },
        policySet
      );
      return {
        nodeId: node.nodeId ?? `node-${index}`,
        capability,
        outcome: decision.outcome,
        reason: decision.reason,
        wouldBlock: shouldBlock(decision),
        observedOnly: decision.observedOnly,
        matched: decision.matched,
        governingPolicyIds: decision.governingPolicyIds,
        message: decision.message,
      };
    });

    return NextResponse.json({
      policyVersion: policySet?.version ?? null,
      // Null means the store could not be read. The caller must not read that
      // as "no policies apply".
      policySetAvailable: policySet !== null,
      results,
    });
  } catch (error) {
    return apiError(error, "Failed to simulate policy");
  }
}
