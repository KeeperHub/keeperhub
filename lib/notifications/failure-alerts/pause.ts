import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowFailureIncidents, workflows } from "@/lib/db/schema";
import type { FailureIncidentResolution } from "@/lib/db/schema-failure-alerts";
import { loadOrgMembers } from "@/lib/notifications/org-recipients";
import { recordAuditEvent } from "@/lib/security/audit-log";
import type { TriggerNodeLike } from "@/lib/workflow/trigger-display-key";
import type { EffectivePolicy } from "./policy";
import { insertDeliveries, rowsForPolicy, type Tx } from "./queue-rows";
import { runsOnItsOwn, workflowTriggerType } from "./workflow-trigger";

// "Pause at the limit". Re-enabling is caught by a DB trigger on
// workflows.enabled, so editor, API, MCP and admin all count.

type IncidentRow = typeof workflowFailureIncidents.$inferSelect;
type PauseState = Pick<IncidentRow, "workflowPausedAt" | "workflowResumedAt">;

type PausableWorkflow = {
  id: string;
  organizationId: string;
  deactivatedAt: Date | null;
  nodes: TriggerNodeLike[];
};

/** Turned off by its incident, and nobody has turned it back on since. */
export function isHeld(incident: PauseState): boolean {
  return (
    incident.workflowPausedAt !== null &&
    (incident.workflowResumedAt === null ||
      incident.workflowResumedAt < incident.workflowPausedAt)
  );
}

/** isHeld for queries that pick incidents to close. */
export const HELD_SQL = sql`(${workflowFailureIncidents.workflowPausedAt} IS NOT NULL
  AND (${workflowFailureIncidents.workflowResumedAt} IS NULL
    OR ${workflowFailureIncidents.workflowResumedAt} < ${workflowFailureIncidents.workflowPausedAt}))`;

/** The incident's own pause holds it open: stopped is not fixed. */
export function heldByPause(
  incident: PauseState,
  workflow: PausableWorkflow,
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
    .set({ workflowPausedAt: now })
    .where(eq(workflowFailureIncidents.id, incidentId));
  return true;
}

/** The audit row for a pause, written once its transaction committed. */
export async function recordPause(
  workflow: PausableWorkflow,
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
    action: "workflow.paused_by_failure_alerts",
    resourceType: "workflow",
    resourceId: workflow.id,
    before: { enabled: true },
    after: { enabled: false },
    metadata: { incidentId, failureCount },
  });
}

class ClaimLost extends Error {}

/** Pause an already-open incident's workflow in one transaction, so it is never off silently. */
export async function pauseOpenIncident(params: {
  workflow: PausableWorkflow;
  incident: IncidentRow;
  policy: EffectivePolicy;
  failures: number;
  again: boolean;
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
          again
            ? { pausedAgain: true, failures }
            : { workflowPaused: true, failures }
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
  await recordPause(workflow, incident.id, failures);
  return queued;
}
