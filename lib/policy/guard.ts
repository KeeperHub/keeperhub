import "server-only";

/**
 * The server-side guardrail every enforcement point calls.
 *
 * One function, four checkpoints. It loads the policy set, resolves the grant,
 * evaluates, records the decision, and returns a verdict the caller acts on.
 *
 * Everything is wrapped so that any unexpected throw becomes a denial. That is
 * the single most important property here: a bug in the policy engine must
 * never read as permission.
 */

import { db } from "@/lib/db";
import { policyDecisions } from "@/lib/db/schema";
import {
  ErrorCategory,
  logSystemWarn,
  logUserError,
  logWarn,
} from "@/lib/logging";
import type { Capability } from "./capabilities";
import {
  FactProvenance,
  FactState,
  POLICY_RECEIPT_TTL_MS,
  type PolicyCheckpoint,
  PolicyDecisionReason,
  PolicyOutcome,
} from "./constants";
import { evaluatePolicy } from "./engine";
import { POLICY_DENIAL_MESSAGE } from "./errors";
import { failClosedDecision, shouldBlock } from "./evaluator";
import { EMPTY_CALLDATA, intentDigest } from "./intent-digest";
import { type ReservationHandle, reserveLimits } from "./limits";
import {
  type GrantSubject,
  getCompiledPolicySet,
  grantCovers,
  loadGrants,
} from "./store";
import type {
  AssetFact,
  CompiledPolicySet,
  CounterpartyFact,
  PolicyDecision,
  PolicyFacts,
  Principal,
} from "./types";

export type GuardInput = {
  principal: Principal;
  organizationId: string | null | undefined;
  capability: Capability;
  facts: PolicyFacts;
  checkpoint: PolicyCheckpoint;
  /**
   * When set, the grant layer is consulted: the subject must hold a grant
   * covering this resource or the action was never reachable. Control-plane
   * checks that are not resource-scoped leave it unset.
   */
  grantSubject?: GrantSubject;
  executionId?: string;
  nodeId?: string;
  workflowId?: string;
};

export type GuardVerdict = {
  blocked: boolean;
  decision: PolicyDecision;
  /**
   * Budget taken for this action, to be settled when it succeeds and released
   * when it fails. Empty when nothing was charged.
   */
  reservations?: readonly ReservationHandle[];
};

/**
 * Written in place of a value the log cannot represent.
 *
 * Rows carrying it record that a value existed without recording what it was.
 */
export const UNSUMMARISED = "[unsummarised]" as const;

/**
 * The fields of an asset that a policy can be written against.
 *
 * Anything a rule can name is kept so the decision can be re-decided later;
 * everything else is dropped. Raw calldata and decoded arguments never appear.
 */
function summariseAsset(asset: AssetFact): Record<string, unknown> {
  return {
    address: asset.address,
    symbol: asset.symbol,
    decimals: asset.decimals,
    amount: asset.amount,
  };
}

function summariseCounterparty(
  counterparty: CounterpartyFact
): Record<string, unknown> {
  return {
    address: counterparty.address,
    role: counterparty.role,
    label: counterparty.label,
  };
}

/**
 * Reduce one known fact value to what the log stores.
 *
 * Scalars are kept as they are. Assets and counterparties are kept in a
 * structured, trimmed form rather than being flattened, because they are what
 * asset allowlists and counterparty allowlists are written against: a log that
 * discards them cannot answer "would this new rule have blocked that", which is
 * the main question the log exists to answer.
 */
function summariseValue(key: string, raw: unknown): unknown {
  if (
    typeof raw === "string" ||
    typeof raw === "number" ||
    typeof raw === "boolean"
  ) {
    return raw;
  }
  if (!Array.isArray(raw)) {
    return UNSUMMARISED;
  }
  if (key === "assets") {
    return raw.map((item) => summariseAsset(item as AssetFact));
  }
  if (key === "counterparties") {
    return raw.map((item) => summariseCounterparty(item as CounterpartyFact));
  }
  if (raw.every((item) => typeof item === "string")) {
    return raw;
  }
  return UNSUMMARISED;
}

/**
 * Facts are recorded for the decision log, so they are trimmed to what makes a
 * verdict explainable and re-decidable. Full calldata stays out: the log is
 * read by anyone who can see policy, which is a wider audience than the
 * execution.
 */
function summariseFacts(facts: PolicyFacts): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (key === "capability") {
      continue;
    }
    const fact = value as { state?: string; value?: unknown };
    if (fact?.state === FactState.KNOWN) {
      out[key] = summariseValue(key, fact.value);
    } else if (fact?.state) {
      out[key] = fact.state;
    }
  }
  return out;
}

/**
 * The digest an allow leaves behind for the signer to find.
 *
 * Only an allow issues one: a denial never reaches a signer, and an unmanaged
 * action needs no receipt because nothing governs it. A receipt is refused
 * when the action's target is not fully known, since a digest over unknowns
 * would match the wrong transaction.
 */
function receiptFor(
  input: GuardInput,
  decision: PolicyDecision
): string | null {
  if (decision.outcome !== PolicyOutcome.ALLOW) {
    return null;
  }
  const chainId = knownValue<number>(input.facts.chainId);
  const to = knownValue<string>(input.facts.contractAddress);
  if (chainId === null || to === null) {
    return null;
  }
  return intentDigest({
    chainId,
    to,
    selector: knownValue<string>(input.facts.selector) ?? EMPTY_CALLDATA,
    valueWei: knownValue<string>(input.facts.nativeValueWei) ?? "0",
  });
}

function knownValue<T>(fact: { state: string; value?: unknown }): T | null {
  return fact.state === FactState.KNOWN ? ((fact.value as T) ?? null) : null;
}

/**
 * Take the budget the permitting statements require.
 *
 * Reserving before the action rather than counting after it is what makes
 * concurrent actions safe: two transfers racing for the last of a daily cap
 * each see the other's reservation, so they cannot both squeeze under it.
 *
 * A limit with no headroom turns the allow into a denial, which is the only
 * honest outcome: the statement permitted the action, and the budget did not.
 */
async function chargeLimits(input: {
  organizationId: string;
  decision: PolicyDecision;
  policySet: CompiledPolicySet;
  facts: PolicyFacts;
  principal: Principal;
}): Promise<{
  decision: PolicyDecision;
  reservations: readonly ReservationHandle[];
}> {
  if (input.decision.outcome !== PolicyOutcome.ALLOW) {
    return { decision: input.decision, reservations: [] };
  }

  const matched = new Set(
    input.decision.matched.map((m) => `${m.policyId}|${m.sid}`)
  );
  const limits = input.policySet.policies.flatMap((policy) =>
    policy.statements
      .filter((statement) => matched.has(`${policy.policyId}|${statement.sid}`))
      .flatMap((statement) =>
        statement.limits.map((limit) => ({
          policyId: policy.policyId,
          sid: statement.sid,
          limit,
        }))
      )
  );

  if (limits.length === 0) {
    return { decision: input.decision, reservations: [] };
  }

  const outcome = await reserveLimits({
    organizationId: input.organizationId,
    limits,
    facts: input.facts,
    principal: input.principal,
  });

  if (outcome.ok) {
    return { decision: input.decision, reservations: outcome.reservations };
  }

  return {
    decision: {
      ...input.decision,
      outcome: PolicyOutcome.DENY,
      reason: PolicyDecisionReason.LIMIT_EXCEEDED,
      message: POLICY_DENIAL_MESSAGE[PolicyDecisionReason.LIMIT_EXCEEDED],
    },
    reservations: [],
  };
}

/**
 * Announce a refusal that monitor mode let through.
 *
 * Monitor mode exists to show what a policy would do before it can hurt
 * anything, and a signal nobody is told about does not do that. The decision
 * log holds it either way; this is what makes it visible to whoever is watching
 * a run rather than only to whoever thinks to open the page.
 *
 * A warning rather than an error: the policy is working, and the organization
 * asked for it not to block yet. Raising it as a system error would page
 * somebody every time a customer tries a rule out.
 */
function reportObservedBlock(
  input: GuardInput,
  organizationId: string,
  decision: PolicyDecision
): void {
  if (!decision.observedOnly) {
    return;
  }
  if (
    decision.outcome === PolicyOutcome.ALLOW ||
    decision.outcome === PolicyOutcome.UNMANAGED
  ) {
    return;
  }

  logWarn("[Policy] A policy in monitor mode would have blocked this action", {
    organizationId,
    capability: input.capability,
    outcome: decision.outcome,
    reason: decision.reason,
    // Safe to name here: this reaches the operator's own logs, not the
    // person who ran the workflow.
    matched: decision.matched.map((m) => m.sid).join(",") || "none",
    workflowId: input.workflowId ?? "",
    nodeId: input.nodeId ?? "",
  });
}

async function recordDecision(
  input: GuardInput,
  organizationId: string,
  decision: PolicyDecision
): Promise<void> {
  // Unmanaged decisions are the overwhelming majority and carry no
  // information: an organization with no policy would otherwise write a row per
  // node per run forever. Only governed outcomes are persisted.
  if (decision.outcome === PolicyOutcome.UNMANAGED) {
    return;
  }
  try {
    const resource =
      input.facts.resource.state === FactState.KNOWN
        ? String(input.facts.resource.value)
        : null;
    await db.insert(policyDecisions).values({
      organizationId,
      checkpoint: input.checkpoint,
      capability: input.capability,
      resource,
      outcome: decision.outcome,
      reason: decision.reason,
      matchedSids: decision.matched.map((m) => m.sid),
      governingPolicyIds: decision.governingPolicyIds,
      facts: summariseFacts(input.facts),
      // A receipt, so the signing check can recognise an action this decision
      // already permitted rather than deciding it a second time without the
      // context this layer had.
      intentDigest: receiptFor(input, decision),
      receiptStatus: receiptFor(input, decision) ? "pending" : null,
      receiptExpiresAt: receiptFor(input, decision)
        ? new Date(Date.now() + POLICY_RECEIPT_TTL_MS)
        : null,
      observedOnly: decision.observedOnly,
      policyVersion: decision.policyVersion,
      principalKind: input.principal.kind,
      principalId: principalIdOf(input.principal),
      executionId: input.executionId,
      nodeId: input.nodeId,
      workflowId: input.workflowId,
      durationMs: decision.durationMs,
    });
  } catch (error) {
    // Losing a log row must never turn an allow into a deny or the reverse.
    logSystemWarn(
      ErrorCategory.DATABASE,
      "[Policy] Failed to record a policy decision",
      error instanceof Error ? error : new Error(String(error)),
      { organizationId }
    );
  }
}

function principalIdOf(principal: Principal): string | undefined {
  switch (principal.kind) {
    case "member":
    case "oauth":
      return principal.userId;
    case "api_key":
      return principal.apiKeyId;
    case "service":
      return principal.service;
    case "platform":
      return principal.operator;
    default:
      return undefined;
  }
}

/**
 * Resolve the grant, then evaluate policy.
 *
 * Order matters. A missing grant means the resource was never reachable, which
 * is a different answer from a rule refusing, and the two are worth telling
 * apart when someone asks why a workflow stopped.
 *
 * A grant also promotes the resource fact to authoritative. That is what makes
 * a templated target usable at all: the template selects among granted
 * resources rather than naming arbitrary ones, so upstream data can steer the
 * choice but never widen it.
 */
async function resolveGrantFact(
  input: GuardInput,
  organizationId: string
): Promise<{ ok: true; facts: PolicyFacts } | { ok: false }> {
  if (!input.grantSubject) {
    return { ok: true, facts: input.facts };
  }
  if (input.facts.resource.state !== FactState.KNOWN) {
    return { ok: true, facts: input.facts };
  }

  const grants = await loadGrants(organizationId, input.grantSubject);
  if (grants.length === 0) {
    // No grants at all means the subject predates the grant layer. Treating
    // that as "reaches nothing" would deny every existing workflow, so it is
    // left to policy, and the backfill is what closes this gap.
    return { ok: true, facts: input.facts };
  }

  const resource = String(input.facts.resource.value);
  const covering = grantCovers(grants, resource, input.capability);
  if (!covering) {
    return { ok: false };
  }

  return {
    ok: true,
    facts: {
      ...input.facts,
      resource: {
        state: FactState.KNOWN,
        value: resource,
        provenance: FactProvenance.AUTHORITATIVE,
      },
    },
  };
}

export async function enforcePolicy(input: GuardInput): Promise<GuardVerdict> {
  try {
    const organizationId = input.organizationId;
    if (!organizationId) {
      const decision = failClosedDecision(PolicyDecisionReason.NO_PRINCIPAL);
      return { blocked: true, decision };
    }

    const policySet = await getCompiledPolicySet(organizationId);
    if (policySet === null) {
      // Null is "could not read", never "no policies". Failing open here would
      // make a database blip a way to bypass every guardrail in the product.
      const decision = failClosedDecision(
        PolicyDecisionReason.STORE_UNAVAILABLE
      );
      await recordDecision(input, organizationId, decision);
      return { blocked: true, decision };
    }

    const grant = await resolveGrantFact(input, organizationId);
    if (!grant.ok) {
      const decision = failClosedDecision(PolicyDecisionReason.NOT_GRANTED);
      await recordDecision(input, organizationId, decision);
      logUserError(
        ErrorCategory.VALIDATION,
        "[Policy] Action refused: the subject holds no grant for this resource",
        undefined,
        { organizationId, capability: input.capability }
      );
      return { blocked: true, decision };
    }

    const decision = evaluatePolicy(
      {
        principal: input.principal,
        organizationId,
        capability: input.capability,
        facts: grant.facts,
        checkpoint: input.checkpoint,
        executionId: input.executionId,
        nodeId: input.nodeId,
        workflowId: input.workflowId,
      },
      policySet
    );

    // An allow only stands once its budget is taken. Deciding without charging
    // would let a policy declare a daily cap that nothing enforces.
    const charged = await chargeLimits({
      organizationId,
      decision,
      policySet,
      facts: grant.facts,
      principal: input.principal,
    });

    await recordDecision(input, organizationId, charged.decision);
    reportObservedBlock(input, organizationId, charged.decision);
    return {
      blocked: shouldBlock(charged.decision),
      decision: charged.decision,
      reservations: charged.reservations,
    };
  } catch (error) {
    // The line that stops an engine bug becoming an authorization bypass.
    logSystemWarn(
      ErrorCategory.WORKFLOW_ENGINE,
      "[Policy] The policy check threw; failing closed",
      error instanceof Error ? error : new Error(String(error)),
      { capability: input.capability }
    );
    return {
      blocked: true,
      decision: failClosedDecision(PolicyDecisionReason.ENGINE_ERROR),
    };
  }
}
