import "server-only";

/**
 * The per-node policy check, as a workflow step.
 *
 * The workflow body cannot do I/O: reading policy and grants needs the database
 * driver, so the check crosses a "use step" boundary the same way the executor's
 * logging writes do.
 *
 * Every node calls this before it dispatches, after its own templates resolve.
 * That timing is the point: the values a policy cares about, such as a
 * recipient supplied by an upstream node, do not exist any earlier.
 */

import { ErrorCategory, logSystemError } from "@/lib/logging";
import { PolicyCheckpoint, type PolicyRole, PrincipalKind } from "@/lib/policy";
import { resolveCallCapability } from "@/lib/policy/catalog/call-capability";
import { explainDenial } from "@/lib/policy/errors";
import { capabilityForAction, extractFacts } from "@/lib/policy/facts";
import { enforcePolicy } from "@/lib/policy/guard";
import {
  type ReservationHandle,
  releaseReservations,
  settleReservations,
} from "@/lib/policy/limits";
import { withUsdValue } from "@/lib/policy/price";
import type { Principal } from "@/lib/policy/types";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getOrgRole } from "@/lib/security/org-role";
import { logStepCompleteDb, logStepStartDb } from "./logging";

export type PolicyCheckInput = {
  actionType: string;
  config: Record<string, unknown>;
  organizationId?: string;
  createdBy?: string;
  executionId?: string;
  nodeId?: string;
  workflowId?: string;
  triggerType?: string;
  /** Shown on the failed step, so a reader sees the node they recognise. */
  nodeName?: string;
};

export type PolicyCheckResult = {
  blocked: boolean;
  /** Budget taken for this node, to settle or release once it finishes. */
  reservations?: readonly ReservationHandle[];
  /** User-facing, already redacted. Empty when the action was permitted. */
  message: string;
  reason?: string;
  outcome?: string;
};

/** Names the principal a run acts as when no member role can be established. */
const WORKFLOW_EXECUTOR = "workflow-executor";

function resolveChainId(config: Record<string, unknown>): number | undefined {
  const network = config.network;
  if (typeof network !== "string" || network.trim() === "") {
    return undefined;
  }
  const chainId = getChainIdFromNetwork(network);
  return typeof chainId === "number" ? chainId : undefined;
}

/**
 * Who this node runs as.
 *
 * The creator's role is read from the organization, never assumed. Assuming one
 * would feed the engine a fact it did not establish, and a rule keyed on role
 * would then be deciding on a value this file made up: an owner-created
 * workflow judged as a member, or worse, a removed member still counted as one.
 *
 * When the role cannot be established the principal carries none rather than a
 * default. A missing fact makes an `allow` not match and a `deny` match, which
 * is the fail-closed rule doing its job; a fabricated "member" would quietly
 * satisfy rules that were never meant to cover it.
 */
async function resolveRunPrincipal(
  input: PolicyCheckInput
): Promise<Principal> {
  const { createdBy, organizationId } = input;
  if (!(createdBy && organizationId)) {
    return { kind: PrincipalKind.SERVICE, service: WORKFLOW_EXECUTOR };
  }

  const role = await getOrgRole(createdBy, organizationId);
  if (!role) {
    // The creator is no longer a member of this organization. Their workflow
    // keeps running, but it runs with no role rather than inheriting one.
    return { kind: PrincipalKind.SERVICE, service: WORKFLOW_EXECUTOR };
  }

  return {
    kind: PrincipalKind.MEMBER,
    userId: createdBy,
    organizationId,
    role: role as PolicyRole,
  };
}

/**
 * Decide whether this node may run.
 *
 * Returns a verdict rather than throwing, so the executor turns a refusal into
 * an ordinary failed node carrying the right fault domain. A thrown error here
 * would reach the message classifier, which defaults an unrecognised message to
 * a platform fault and would page somebody every time a customer's own rule did
 * its job.
 */
export async function policyCheckStep(
  input: PolicyCheckInput
): Promise<PolicyCheckResult> {
  "use step";

  const capability = capabilityForAction(input.actionType);
  if (!capability) {
    // An action with no capability mapping is not governed by any rule yet.
    // Treating it as blocked would stop unrelated work every time a plugin is
    // added; the registry test is what stops a write-capable action sitting
    // here unnoticed.
    return { blocked: false, message: "" };
  }

  const chainId = resolveChainId(input.config);
  const extracted = extractFacts({
    actionType: input.actionType,
    config: input.config,
    chainId,
    triggerType: input.triggerType,
    workflowId: input.workflowId,
  });

  // Pricing is a network read, so it happens here rather than inside the pure
  // extractor. Without it a dollar limit could never bind on anything.
  const facts = await withUsdValue(extracted, chainId);

  // The capability above is read from the action-type slug, which the workflow
  // author chose. Where the call resolves to a known selector, the catalog says
  // what the function actually does, and that wins: otherwise a rule denying
  // borrowing is sidestepped by performing the same call through a raw contract
  // write, whose slug names no verb at all.
  const effectiveCapability = await resolveCallCapability({
    chainId,
    facts,
    fallback: capability,
  });

  const verdict = await enforcePolicy({
    principal: await resolveRunPrincipal(input),
    organizationId: input.organizationId,
    capability: effectiveCapability,
    facts,
    checkpoint: PolicyCheckpoint.NODE,
    grantSubject: input.workflowId
      ? { kind: "workflow", id: input.workflowId }
      : undefined,
    executionId: input.executionId,
    nodeId: input.nodeId,
    workflowId: input.workflowId,
  });

  const message = verdict.blocked
    ? explainDenial({
        reason: verdict.decision.reason,
        organizationId: input.organizationId,
      })
    : "";

  // A refusal happens before the node runs, so no step row exists yet, and
  // everything a reader sees about a run is built from step rows. Without this
  // a blocked run looked like one that had simply finished early: no failed
  // step, no message, nothing saying a rule refused it. The decision was in the
  // policy log the whole time, which is worse, because the place somebody
  // actually looks said nothing was wrong.
  if (verdict.blocked && input.executionId && input.nodeId) {
    try {
      const started = await logStepStartDb({
        executionId: input.executionId,
        nodeId: input.nodeId,
        nodeName: input.nodeName ?? input.actionType,
        nodeType: input.actionType,
        input: input.config,
      });
      await logStepCompleteDb({
        logId: started.logId,
        startTime: started.startTime,
        status: "error",
        error: message,
        executionId: input.executionId,
      });
    } catch (loggingError) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[Policy] Could not record a refusal as a step",
        loggingError,
        { nodeId: input.nodeId }
      );
    }
  }

  return {
    blocked: verdict.blocked,
    // Why, and where to look, and nothing about which rule decided. This text
    // reaches whoever ran the workflow, and a member who cannot read policy
    // must not learn its contents by being refused by it.
    message,
    reason: verdict.decision.reason,
    outcome: verdict.decision.outcome,
    reservations: verdict.reservations ?? [],
  };
}

/**
 * Close out the budget a node took.
 *
 * Settled when the node succeeded, released when it did not. A failed
 * transaction that keeps its reservation would let a run of failures exhaust a
 * budget nothing was ever spent from.
 */
export async function policySettleStep(input: {
  reservations: readonly ReservationHandle[];
  succeeded: boolean;
}): Promise<void> {
  "use step";

  if (input.reservations.length === 0) {
    return;
  }
  if (input.succeeded) {
    await settleReservations(input.reservations);
    return;
  }
  await releaseReservations(input.reservations);
}
