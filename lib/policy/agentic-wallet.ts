import "server-only";

/**
 * The policy check for an agentic wallet signature.
 *
 * This wallet signs payment challenges rather than transactions it assembles,
 * so it never reaches an ethers signer and the guard that stands behind every
 * other write does not stand behind it. It ran instead on its own controls: a
 * risk classifier and a daily spend cap that no organization rule can see.
 *
 * Those stay. This adds the organization's own rules on top, so "never pay this
 * address" and "no more than this much a day" mean the same thing here as they
 * do everywhere else.
 *
 * A wallet with no organization is not governed, because policy is written by
 * an organization and there is none to ask. That is recorded when the wallet is
 * linked; a wallet provisioned and never linked belongs to nobody.
 */

import { NextResponse } from "next/server";
import { buildAssetArn } from "./arn";
import { Capability } from "./capabilities";
import { enforcePolicy } from "./guard";
import {
  FactProvenance,
  FactState,
  PolicyCheckpoint,
  PolicyRole,
  PrincipalKind,
} from "./index";
import type { PolicyFacts } from "./types";

const UNKNOWN = { state: FactState.UNKNOWN } as const;

const known = <T>(value: T) =>
  ({
    state: FactState.KNOWN,
    value,
    provenance: FactProvenance.AUTHORITATIVE,
  }) as const;

export type AgenticWalletCheck = {
  organizationId: string;
  subOrgId: string;
  chainId: number;
  /**
   * The token being paid, when the caller knows it.
   *
   * The resource is the asset, not the recipient, because that is what a token
   * transfer presents everywhere else in the system. Naming the recipient here
   * instead would mean a rule scoped to an asset never bound on this path while
   * appearing to, and the recipient is already carried as a counterparty, which
   * is where a rule about who gets paid belongs.
   */
  tokenAddress?: string;
  /** Who is paid. Absent on a proof that names no recipient. */
  recipient?: string;
  /** The amount in millionths of a dollar, as the challenge states it. */
  amountMicro?: string;
};

const WHOLE_NUMBER = /^\d+$/;
const TRAILING_ZEROS = /0+$/;

/** Micro-dollars to a decimal dollar string, without floating point. */
function microToUsd(amountMicro: string): string | undefined {
  if (!WHOLE_NUMBER.test(amountMicro)) {
    return undefined;
  }
  const padded = amountMicro.padStart(7, "0");
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(TRAILING_ZEROS, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function agenticFacts(check: AgenticWalletCheck): PolicyFacts {
  const usd = check.amountMicro ? microToUsd(check.amountMicro) : undefined;
  const recipient = check.recipient?.toLowerCase();
  const token = check.tokenAddress?.toLowerCase();

  return {
    capability: Capability.ASSET_TRANSFER_TOKEN,
    resource: token
      ? known(buildAssetArn({ chainId: check.chainId, tokenAddress: token }))
      : UNKNOWN,
    chainId: known(check.chainId),
    contractAddress: UNKNOWN,
    selector: UNKNOWN,
    protocolSlug: UNKNOWN,
    assets: token
      ? known([{ address: token, amount: check.amountMicro }])
      : UNKNOWN,
    counterparties: recipient
      ? known([{ address: recipient, role: "recipient" }])
      : UNKNOWN,
    nativeValueWei: UNKNOWN,
    usdValue: usd ? known(usd) : UNKNOWN,
    unbounded: UNKNOWN,
    gasPriceGwei: UNKNOWN,
    gasLimit: UNKNOWN,
    signerMode: UNKNOWN,
    // Named so a rule can bound the agent surface without naming every
    // capability it might exercise.
    triggerType: known("agent"),
    workflowId: UNKNOWN,
    workflowTags: UNKNOWN,
    projectId: UNKNOWN,
    sourceIp: UNKNOWN,
    httpHost: UNKNOWN,
    httpUrl: UNKNOWN,
    httpMethod: UNKNOWN,
    resourceId: recipient ? known(recipient) : UNKNOWN,
  } as PolicyFacts;
}

/** Returns a ready 403 when policy refuses, or null to proceed. */
export async function enforceAgenticWalletPolicy(
  check: AgenticWalletCheck
): Promise<NextResponse | null> {
  const verdict = await enforcePolicy({
    principal: {
      kind: PrincipalKind.API_KEY,
      apiKeyId: check.subOrgId,
      organizationId: check.organizationId,
      role: PolicyRole.MEMBER,
    },
    organizationId: check.organizationId,
    capability: Capability.ASSET_TRANSFER_TOKEN,
    facts: agenticFacts(check),
    checkpoint: PolicyCheckpoint.NODE,
    grantSubject: { kind: "principal", id: check.subOrgId },
  });

  if (!verdict.blocked) {
    return null;
  }

  return NextResponse.json(
    {
      error: verdict.decision.message ?? "Blocked by an organization policy",
      code: "policy_denied",
      reason: verdict.decision.reason,
    },
    { status: 403 }
  );
}
