import "server-only";

/**
 * The policy check for the direct-execution API.
 *
 * These routes are the paths an agent uses, and they never touch the workflow
 * engine, so the per-node check does not cover them. Without this the most
 * agent-exposed surface in the product would be the one surface policy did not
 * reach.
 *
 * Called immediately before the spending-cap reservation, which is the last
 * gate before a transaction is built.
 */

import { NextResponse } from "next/server";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { buildAssetArn, buildContractCallArn } from "./arn";
import type { Capability } from "./capabilities";
import { resolveCallCapability } from "./catalog/call-capability";
import { capabilityForAction, extractFacts } from "./facts";
import { enforcePolicy } from "./guard";
import {
  FactProvenance,
  FactState,
  PolicyCheckpoint,
  PolicyRole,
  PrincipalKind,
} from "./index";
import { withUsdValue } from "./price";
import type { PolicyFacts } from "./types";

const UNKNOWN = { state: FactState.UNKNOWN } as const;

export type DirectExecutionCheck = {
  organizationId: string;
  apiKeyId: string;
  capability: Capability;
  chainId?: number;
  contractAddress?: string;
  tokenAddress?: string;
  selector?: string;
  recipient?: string;
  /**
   * The native value being sent, in wei.
   *
   * Without it `usdValue` stays absent and a spend limit can never bind on a
   * direct call, which is the whole point of a limit. Token amounts are not
   * carried here: they are denominated in the token's own units, and pricing
   * one without its decimals would produce a confident wrong number.
   */
  nativeValueWei?: string;
};

function directFacts(check: DirectExecutionCheck): PolicyFacts {
  let resource = UNKNOWN as PolicyFacts["resource"];
  if (check.chainId !== undefined && check.contractAddress) {
    resource = {
      state: FactState.KNOWN,
      value: buildContractCallArn({
        chainId: check.chainId,
        contractAddress: check.contractAddress,
        selector: check.selector ?? null,
      }),
      // The caller named this target directly, so it is the request rather than
      // something a workflow computed about itself.
      provenance: FactProvenance.AUTHORITATIVE,
    };
  } else if (check.chainId !== undefined && check.tokenAddress) {
    resource = {
      state: FactState.KNOWN,
      value: buildAssetArn({
        chainId: check.chainId,
        tokenAddress: check.tokenAddress,
      }),
      provenance: FactProvenance.AUTHORITATIVE,
    };
  }

  return {
    capability: check.capability,
    resource,
    chainId:
      check.chainId === undefined
        ? UNKNOWN
        : {
            state: FactState.KNOWN,
            value: check.chainId,
            provenance: FactProvenance.AUTHORITATIVE,
          },
    contractAddress: check.contractAddress
      ? {
          state: FactState.KNOWN,
          value: check.contractAddress.toLowerCase(),
          provenance: FactProvenance.AUTHORITATIVE,
        }
      : UNKNOWN,
    selector: check.selector
      ? {
          state: FactState.KNOWN,
          value: check.selector,
          provenance: FactProvenance.AUTHORITATIVE,
        }
      : UNKNOWN,
    protocolSlug: UNKNOWN,
    assets: UNKNOWN,
    counterparties: UNKNOWN,
    nativeValueWei: check.nativeValueWei
      ? {
          state: FactState.KNOWN,
          value: check.nativeValueWei,
          provenance: FactProvenance.AUTHORITATIVE,
        }
      : UNKNOWN,
    // Priced below, from the value above.
    usdValue: UNKNOWN,
    unbounded: UNKNOWN,
    gasPriceGwei: UNKNOWN,
    gasLimit: UNKNOWN,
    signerMode: UNKNOWN,
    // The trigger for a direct call is the API itself, which is worth naming so
    // a rule like "direct execution may not move funds" is expressible.
    triggerType: {
      state: FactState.KNOWN,
      value: "direct",
      provenance: FactProvenance.AUTHORITATIVE,
    },
    workflowId: UNKNOWN,
    workflowTags: UNKNOWN,
    projectId: UNKNOWN,
    sourceIp: UNKNOWN,
    httpHost: UNKNOWN,
    httpUrl: UNKNOWN,
    httpMethod: UNKNOWN,
    resourceId: check.recipient
      ? {
          state: FactState.KNOWN,
          value: check.recipient.toLowerCase(),
          provenance: FactProvenance.AUTHORITATIVE,
        }
      : UNKNOWN,
  };
}

/**
 * Returns a ready 403 when policy refuses, or null to proceed.
 *
 * The key evaluates as a member, which is the least authority an organization
 * has, because an API key carries no role of its own: neither key table has a
 * role column. That is the safe reading rather than the accurate one, and it
 * means an `actorRole` rule cannot tell an owner's key from anyone else's.
 * Giving a key a role of its own is a schema change and an issuance decision,
 * not something to infer here.
 */
export async function enforceDirectExecutionPolicy(
  check: DirectExecutionCheck
): Promise<NextResponse | null> {
  const verdict = await enforcePolicy({
    principal: {
      kind: PrincipalKind.API_KEY,
      apiKeyId: check.apiKeyId,
      organizationId: check.organizationId,
      role: PolicyRole.MEMBER,
    },
    organizationId: check.organizationId,
    capability: check.capability,
    facts: await withUsdValue(directFacts(check), check.chainId),
    checkpoint: PolicyCheckpoint.NODE,
    grantSubject: { kind: "principal", id: check.apiKeyId },
  });

  if (!verdict.blocked) {
    return null;
  }

  return NextResponse.json(
    {
      error: verdict.decision.message ?? "Blocked by an organization policy",
      code: "policy_denied",
      reason: verdict.decision.reason,
      retryable: false,
    },
    { status: 403 }
  );
}

/**
 * The policy check for a direct call that runs a node action.
 *
 * `/api/execute/node` and `/api/execute/check-and-execute` take an action type
 * and a config, which is what a workflow node is, so they reuse the node's own
 * extraction rather than a second, thinner one. That matters most for reads: a
 * read never reaches a signer, so the signing check cannot stand behind it, and
 * before this the only read anybody governed was one inside a workflow.
 *
 * The chain is priced and the selector resolved exactly as the node check does
 * it, so the same rule reaches the same verdict whichever door the call came
 * through.
 */
export async function enforceDirectNodePolicy(check: {
  organizationId: string;
  apiKeyId: string;
  actionType: string;
  config: Record<string, unknown>;
}): Promise<NextResponse | null> {
  const capability = capabilityForAction(check.actionType);
  if (!capability) {
    // No capability mapping yet, so no rule can name it. The registry test is
    // what stops a write-capable action sitting here unnoticed.
    return null;
  }

  const network = check.config.network;
  const chainId =
    typeof network === "string" && network.trim() !== ""
      ? (getChainIdFromNetwork(network) ?? undefined)
      : undefined;

  const extracted = extractFacts({
    actionType: check.actionType,
    config: check.config,
    chainId,
    triggerType: "direct",
  });
  const facts = await withUsdValue(extracted, chainId);

  const effectiveCapability = await resolveCallCapability({
    chainId,
    facts,
    fallback: capability,
  });

  const verdict = await enforcePolicy({
    principal: {
      kind: PrincipalKind.API_KEY,
      apiKeyId: check.apiKeyId,
      organizationId: check.organizationId,
      role: PolicyRole.MEMBER,
    },
    organizationId: check.organizationId,
    capability: effectiveCapability,
    facts,
    checkpoint: PolicyCheckpoint.NODE,
    grantSubject: { kind: "principal", id: check.apiKeyId },
  });

  if (!verdict.blocked) {
    return null;
  }

  return NextResponse.json(
    {
      error: verdict.decision.message ?? "Blocked by an organization policy",
      code: "policy_denied",
      reason: verdict.decision.reason,
      retryable: false,
    },
    { status: 403 }
  );
}
