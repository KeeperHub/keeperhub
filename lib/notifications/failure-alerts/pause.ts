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

/**
 * "Pause this workflow when it reaches the limit": turning a workflow off for
 * its incident, holding the incident open while it stays off, and pausing it
 * again if it keeps failing once someone turns it back on.
 *
 * Turning it back on is recorded by a database trigger on workflows.enabled
 * (workflow_resumed_at), so every way of switching it on counts: the editor,
 * the API, MCP or an admin.
 */

type IncidentRow = typeof workflowFailureIncidents.$inferSelect;
type PauseState = Pick<IncidentRow, "workflowPausedAt" | "workflowResumedAt">;

export type PausableWorkflow = {
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

/**
 * True while an incident's own pause keeps its workflow off. The incident then
 * stays open: the workflow is stopped, not fixed, and its PagerDuty page and
 * the "Failing" state should stay until someone turns it back on and it works.
 * Once someone has turned it back on, turning it off again is theirs, and the
 * incident closes like any paused workflow's.
 */
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

/**
 * Turn a workflow off for its incident, the way its Enable switch does: every
 * trigger checks `enabled` before it starts a run. False when it was already
 * off (someone paused it first), which leaves the incident as it was.
 */
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

/**
 * Pause the workflow of an incident that is already open: the box was ticked
 * after the alert went out, or the workflow kept failing after someone turned
 * it back on. Sent as the incident's next reminder. Claiming that reminder,
 * turning the workflow off and queueing the message are one transaction, so
 * the workflow is never off without a word and two evaluators never both
 * send it. Returns how many messages were queued.
 */
export async function pauseOpenIncident(params: {
  workflow: PausableWorkflow;
  incident: IncidentRow;
  policy: EffectivePolicy;
  failures: number;
  again: boolean;
  now: Date;
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
          now,
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
