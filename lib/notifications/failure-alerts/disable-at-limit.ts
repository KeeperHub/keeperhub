import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowFailureIncidents, workflows } from "@/lib/db/schema";
import type { FailureIncidentResolution } from "@/lib/db/schema-failure-alerts";
import type { Tx } from "@/lib/db/tx";
import { loadOrgMembers } from "@/lib/notifications/org-recipients";
import { recordAuditEvent } from "@/lib/security/audit-log";
import type { TriggerNodeLike } from "@/lib/workflow/trigger-display-key";
import type { EffectivePolicy } from "./policy";
import { insertDeliveries, rowsForPolicy } from "./queue-rows";
import { runsOnItsOwn, workflowTriggerType } from "./workflow-trigger";

// "Disable at the limit". Re-enabling is caught by a DB trigger on
// workflows.enabled, so editor, API, MCP and admin all count.

type IncidentRow = typeof workflowFailureIncidents.$inferSelect;
type DisableState = Pick<
  IncidentRow,
  "workflowDisabledAt" | "workflowReenabledAt"
>;

type DisableTarget = {
  id: string;
  organizationId: string;
  deactivatedAt: Date | null;
  nodes: TriggerNodeLike[];
};

/** Turned off by its incident, and nobody has turned it back on since. */
export function isHeld(incident: DisableState): boolean {
  return (
    incident.workflowDisabledAt !== null &&
    (incident.workflowReenabledAt === null ||
      incident.workflowReenabledAt < incident.workflowDisabledAt)
  );
}

/** isHeld for queries that pick incidents to close. */
export const HELD_SQL = sql`(${workflowFailureIncidents.workflowDisabledAt} IS NOT NULL
  AND (${workflowFailureIncidents.workflowReenabledAt} IS NULL
    OR ${workflowFailureIncidents.workflowReenabledAt} < ${workflowFailureIncidents.workflowDisabledAt}))`;

/** Turned off by its own incident, which stays open: stopped is not fixed. */
export function heldWhileDisabled(
  incident: DisableState,
  workflow: DisableTarget,
  reason: FailureIncidentResolution
): boolean {
  return (
    reason === "disabled" &&
    isHeld(incident) &&
    workflow.deactivatedAt === null &&
    runsOnItsOwn(workflowTriggerType(workflow.nodes))
  );
}

/** Turn the workflow off like its Enable switch; false if it was already off. */
export async function turnOffForIncident(
  tx: Tx,
  workflowId: string,
  incidentId: string,
  now: Date
): Promise<boolean> {
  const updated = await tx
    .update(workflows)
    .set({ enabled: false, updatedAt: now })
    .where(
      and(
        eq(workflows.id, workflowId),
        eq(workflows.enabled, true),
        isNull(workflows.deletedAt)
      )
    )
    .returning({ id: workflows.id });
  if (updated.length === 0) {
    return false;
  }
  await tx
    .update(workflowFailureIncidents)
    .set({ workflowDisabledAt: now })
    .where(eq(workflowFailureIncidents.id, incidentId));
  return true;
}

/** The audit row for turning it off, written once its transaction committed. */
export async function recordDisable(
  workflow: DisableTarget,
  incidentId: string,
  failureCount: number
): Promise<void> {
  await recordAuditEvent({
    actor: {
      userId: null,
      organizationId: workflow.organizationId,
      authMethod: "internal",
      actorLabel: "Failure notifications",
    },
    action: "workflow.disabled_by_failure_alerts",
    resourceType: "workflow",
    resourceId: workflow.id,
    before: { enabled: true },
    after: { enabled: false },
    metadata: { incidentId, failureCount },
  });
}

class ClaimLost extends Error {}

/** Turn off an already-open incident's workflow in one transaction, so it is never off silently. */
export async function disableForOpenIncident(params: {
  workflow: DisableTarget;
  incident: IncidentRow;
  policy: EffectivePolicy;
  failures: number;
  again: boolean;
  /** Turned off because the wallet ran out of funds, not the failure limit. */
  outOfFunds?: boolean;
  now: Date;
  /** Org-wide pause: turn it off now, tell people when the pause ends. */
  holdUntil?: Date;
}): Promise<number> {
  const { workflow, incident, policy, failures, again, now } = params;
  const members = await loadOrgMembers(workflow.organizationId);
  const sequence = incident.reminderCount + 1;
  let queued: number | null;
  try {
    queued = await db.transaction(async (tx: Tx) => {
      const claimed = await tx
        .update(workflowFailureIncidents)
        .set({ reminderCount: sequence, lastNotifiedAt: now })
        .where(
          and(
            eq(workflowFailureIncidents.id, incident.id),
            eq(workflowFailureIncidents.reminderCount, incident.reminderCount)
          )
        )
        .returning({ id: workflowFailureIncidents.id });
      if (claimed.length === 0) {
        return null;
      }
      if (!(await turnOffForIncident(tx, workflow.id, incident.id, now))) {
        // Already off: undo the claim, nothing to announce.
        throw new ClaimLost();
      }
      return await insertDeliveries(
        rowsForPolicy(
          policy,
          members,
          workflow.organizationId,
          incident.id,
          "reminder",
          sequence,
          params.holdUntil ?? now,
          {
            ...(again ? { disabledAgain: true } : { workflowDisabled: true }),
            failures,
            ...(params.outOfFunds ? { outOfFunds: true } : {}),
          }
        ),
        tx
      );
    });
  } catch (error) {
    if (error instanceof ClaimLost) {
      return 0;
    }
    throw error;
  }
  if (queued === null) {
    return 0;
  }
  await recordDisable(workflow, incident.id, failures);
  return queued;
}
