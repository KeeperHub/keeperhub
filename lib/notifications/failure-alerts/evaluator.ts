import "server-only";

import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  failureAlertDeliveries,
  orgFailureAlertSettings,
  workflowExecutions,
  workflowFailureAlertOverrides,
  workflowFailureAlertQueue,
  workflowFailureIncidents,
  workflows,
} from "@/lib/db/schema";
import type {
  FailureAlertDeliveryChannel,
  FailureAlertMessageKind,
  FailureIncidentResolution,
} from "@/lib/db/schema-failure-alerts";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  loadOrgMembers,
  type OrgMember,
} from "@/lib/notifications/org-recipients";
import { recordAuditEvent } from "@/lib/security/audit-log";
import type { TriggerNodeLike } from "@/lib/workflow/trigger-display-key";
import {
  ALERT_REQUEUE_AFTER_MS,
  BACKUP_AFTER_MS,
  DEFAULT_THRESHOLD,
  GROUP_ALERTS_FROM,
  MAX_REMINDERS,
  MAX_WORKFLOWS_PER_RUN,
  REMINDER_INTERVAL_MS,
} from "./constants";
import {
  type ChannelConfig,
  type EffectivePolicy,
  ensureOrgSettings,
  isMuted,
  loadChannels,
  loadEffectivePolicy,
  loadOrgPolicy,
  resolveRecipientEmails,
} from "./policy";
import {
  channelRecipient,
  type DeliveryInsert,
  groupScope,
  incidentScope,
  insertDeliveries,
  type Tx,
} from "./queue-rows";
import { isFailureAlertsEnabledForOrg } from "./rollout";
import { decide, type StreakRun, summarizeStreak } from "./streak";
import {
  AUTOMATIC_TRIGGERS,
  runsOnItsOwn,
  workflowTriggerType,
} from "./workflow-trigger";

const MIN_STREAK_WINDOW = 10;
const STREAK_WINDOW_MULTIPLIER = 4;
const LEASE = sql`now() + interval '5 minutes'`;

type WorkflowRow = {
  id: string;
  name: string;
  organizationId: string;
  enabled: boolean;
  deletedAt: Date | null;
  deactivatedAt: Date | null;
  nodes: TriggerNodeLike[];
};

type IncidentRow = typeof workflowFailureIncidents.$inferSelect;

type OpenedIncident = {
  id: string;
  organizationId: string;
  workflowId: string;
};

export type EvaluationStats = {
  workflowsEvaluated: number;
  incidentsOpened: number;
  incidentsResolved: number;
  remindersQueued: number;
  messagesQueued: number;
};

export function emptyStats(): EvaluationStats {
  return {
    workflowsEvaluated: 0,
    incidentsOpened: 0,
    incidentsResolved: 0,
    remindersQueued: 0,
    messagesQueued: 0,
  };
}

/**
 * Take a batch of due workflows. Each row's due time is pushed five minutes
 * out as a lease; a run status written meanwhile pulls it back to now, and
 * the release below then leaves it for the next cycle instead of losing it.
 *
 * The lease travels as Postgres's own text form of the timestamp. Read into a
 * JS Date through a raw query it would be parsed in the process's local time
 * zone, and the release would never match it outside UTC.
 */
async function claimQueue(): Promise<{ workflowId: string; lease: string }[]> {
  const rows = await db.execute<{ workflow_id: string; lease: string }>(sql`
    UPDATE ${workflowFailureAlertQueue}
    SET due_at = ${LEASE}
    WHERE workflow_id IN (
      SELECT workflow_id FROM ${workflowFailureAlertQueue}
      WHERE due_at <= now()
      ORDER BY due_at
      LIMIT ${MAX_WORKFLOWS_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING workflow_id, due_at::text AS lease
  `);
  return [...rows].map((row) => ({
    workflowId: row.workflow_id,
    lease: row.lease,
  }));
}

async function releaseQueue(
  workflowId: string,
  lease: string,
  recheckAt: Date | null
): Promise<void> {
  if (recheckAt) {
    // An ISO string, not a Date: the raw sql template would send a Date as
    // its local-time display string.
    const at = recheckAt.toISOString();
    await db.execute(sql`
      UPDATE ${workflowFailureAlertQueue}
      SET due_at = CASE WHEN due_at = ${lease}::timestamp
                        THEN (${at}::timestamptz AT TIME ZONE 'UTC')
                        ELSE LEAST(due_at, ${at}::timestamptz AT TIME ZONE 'UTC') END
      WHERE workflow_id = ${workflowId}
    `);
    return;
  }
  await db.execute(sql`
    DELETE FROM ${workflowFailureAlertQueue}
    WHERE workflow_id = ${workflowId} AND due_at = ${lease}::timestamp
  `);
}

async function loadWorkflow(workflowId: string): Promise<WorkflowRow | null> {
  const [row] = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      organizationId: workflows.organizationId,
      enabled: workflows.enabled,
      deletedAt: workflows.deletedAt,
      deactivatedAt: workflows.deactivatedAt,
      nodes: workflows.nodes,
    })
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .limit(1);
  return row ?? null;
}

async function loadRecentRuns(
  workflowId: string,
  limit: number
): Promise<StreakRun[]> {
  return await db
    .select({
      id: workflowExecutions.id,
      status: workflowExecutions.status,
      triggerSource: workflowExecutions.triggerSource,
      credentialType: workflowExecutions.triggeredByCredentialType,
      startedAt: workflowExecutions.startedAt,
      completedAt: workflowExecutions.completedAt,
      error: workflowExecutions.error,
    })
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.workflowId, workflowId),
        isNotNull(workflowExecutions.completedAt),
        isNull(workflowExecutions.deletedAt)
      )
    )
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(limit);
}

async function loadOpenIncident(
  workflowId: string
): Promise<IncidentRow | null> {
  const [row] = await db
    .select()
    .from(workflowFailureIncidents)
    .where(
      and(
        eq(workflowFailureIncidents.workflowId, workflowId),
        isNull(workflowFailureIncidents.resolvedAt)
      )
    )
    .limit(1);
  return row ?? null;
}

function inactiveResolution(
  workflow: WorkflowRow,
  trigger: string | null
): FailureIncidentResolution | null {
  if (workflow.deletedAt) {
    return "deleted";
  }
  if (workflow.deactivatedAt || !workflow.enabled) {
    return "disabled";
  }
  if (!runsOnItsOwn(trigger)) {
    return "manual_trigger";
  }
  return null;
}

/**
 * True while an incident's own pause keeps its workflow off. The incident then
 * stays open: the workflow is stopped, not fixed, and its PagerDuty page and
 * the "Failing" state should stay until someone turns it back on and it works.
 */
function heldByPause(
  incident: Pick<IncidentRow, "workflowPausedAt">,
  workflow: WorkflowRow,
  reason: FailureIncidentResolution
): boolean {
  return (
    reason === "disabled" &&
    incident.workflowPausedAt !== null &&
    workflow.deactivatedAt === null &&
    runsOnItsOwn(workflowTriggerType(workflow.nodes))
  );
}

/**
 * Turn a workflow off for its incident, the way its Enable switch does: every
 * trigger checks `enabled` before it starts a run. False when it was already
 * off (someone paused it first), which leaves the incident as it was.
 */
async function pauseWorkflowFor(
  workflow: WorkflowRow,
  incidentId: string,
  failureCount: number,
  now: Date
): Promise<boolean> {
  const paused = await db.transaction(async (tx) => {
    const updated = await tx
      .update(workflows)
      .set({ enabled: false, updatedAt: now })
      .where(
        and(
          eq(workflows.id, workflow.id),
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
  });
  if (paused) {
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
  return paused;
}

const SKIPPED_BECAUSE: Record<FailureIncidentResolution, string> = {
  success: "The workflow recovered before this was delivered.",
  disabled: "The workflow was paused before this was delivered.",
  deleted: "The workflow was deleted before this was delivered.",
  manual_trigger:
    "The workflow was switched to a manual trigger before this was delivered.",
};

/**
 * Close an incident, whatever closed it.
 *
 * Messages still waiting are dropped. A PagerDuty page that went out (or is
 * going out) is always resolved on the same key, whatever the reason and
 * whether or not the org wants recovery messages: an incident left triggered
 * keeps paging the on-call for a workflow that no longer fails or no longer
 * runs. Email and chat get the "working again" message only when it really
 * recovered and the org asked for it.
 */
async function closeIncident(params: {
  incident: IncidentRow;
  reason: FailureIncidentResolution;
  resolvingExecutionId: string | null;
  notifyRecovery: boolean;
  now: Date;
  stats: EvaluationStats;
}): Promise<void> {
  const { incident, reason, now, stats } = params;
  // One transaction: an incident closed without its PagerDuty resolve queued
  // would never be revisited, and the page would stay open.
  await db.transaction(async (tx) => {
    const closed = await tx
      .update(workflowFailureIncidents)
      .set({
        resolvedAt: now,
        resolvedReason: reason,
        resolvingExecutionId: params.resolvingExecutionId,
      })
      .where(
        and(
          eq(workflowFailureIncidents.id, incident.id),
          isNull(workflowFailureIncidents.resolvedAt)
        )
      )
      .returning({ id: workflowFailureIncidents.id });
    if (closed.length === 0) {
      return;
    }
    stats.incidentsResolved += 1;

    const prior = await tx
      .select({
        channel: failureAlertDeliveries.channel,
        channelId: failureAlertDeliveries.channelId,
        recipient: failureAlertDeliveries.recipient,
        state: failureAlertDeliveries.state,
        attempts: failureAlertDeliveries.attempts,
      })
      .from(failureAlertDeliveries)
      .where(
        and(
          eq(failureAlertDeliveries.organizationId, incident.organizationId),
          sql`(${failureAlertDeliveries.incidentId} = ${incident.id} OR ${failureAlertDeliveries.context} @> ${JSON.stringify({ incidentIds: [incident.id] })}::jsonb)`,
          inArray(failureAlertDeliveries.kind, ["alert", "reminder"])
        )
      );

    await tx
      .update(failureAlertDeliveries)
      .set({
        state: "skipped",
        lastError: SKIPPED_BECAUSE[reason],
        updatedAt: now,
      })
      .where(
        and(
          eq(failureAlertDeliveries.incidentId, incident.id),
          inArray(failureAlertDeliveries.state, ["pending", "retrying"])
        )
      );

    const rows: DeliveryInsert[] = [];
    const seen = new Set<string>();
    const wantRecovery = reason === "success" && params.notifyRecovery;
    for (const row of prior) {
      const pagerDuty = row.channel === "pagerduty";
      // A page still in flight may land after this resolve; send the resolve
      // a little later so it arrives second.
      const inFlight = pagerDuty && row.state === "sending";
      // A page that timed out may still have reached PagerDuty. Resolving a
      // key PagerDuty never saw is harmless, so every attempted page gets one.
      const maybePaged = pagerDuty && row.attempts > 0;
      const reached = row.state === "delivered";
      if (
        !(pagerDuty
          ? reached || inFlight || maybePaged
          : wantRecovery && reached)
      ) {
        continue;
      }
      const key = `${row.channel}:${row.channelId ?? ""}:${row.recipient}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push({
        scope: incidentScope(incident.id),
        organizationId: incident.organizationId,
        incidentId: incident.id,
        kind: "recovery",
        sequence: 0,
        channel: row.channel,
        channelId: row.channelId,
        recipient: row.recipient,
        nextAttemptAt: inFlight ? new Date(now.getTime() + 2 * 60 * 1000) : now,
      });
    }
    stats.messagesQueued += await insertDeliveries(rows, tx);
  });
}

/**
 * Evaluate one workflow. Returns when it should be looked at again without a
 * new run (the time limit or a mute ending), or null.
 */
async function evaluateWorkflow(
  workflowId: string,
  now: Date,
  opened: OpenedIncident[],
  stats: EvaluationStats
): Promise<Date | null> {
  const workflow = await loadWorkflow(workflowId);
  if (!(workflow && isFailureAlertsEnabledForOrg(workflow.organizationId))) {
    return null;
  }
  stats.workflowsEvaluated += 1;

  const open = await loadOpenIncident(workflowId);
  const inactiveReason = inactiveResolution(
    workflow,
    workflowTriggerType(workflow.nodes)
  );
  const org = await loadOrgPolicy(workflow.organizationId);
  if (inactiveReason) {
    if (open && !heldByPause(open, workflow, inactiveReason)) {
      await closeIncident({
        incident: open,
        reason: inactiveReason,
        resolvingExecutionId: null,
        notifyRecovery: org.notifyRecovery,
        now,
        stats,
      });
    }
    return null;
  }

  await ensureOrgSettings(workflow.organizationId, now);
  await queueLaunchNotice(workflow.organizationId, now, stats);

  const policy = await loadEffectivePolicy(workflow.organizationId, workflowId);
  const window = Math.max(
    MIN_STREAK_WINDOW,
    policy.threshold * STREAK_WINDOW_MULTIPLIER
  );
  const runs = await loadRecentRuns(workflowId, window);
  const summary = summarizeStreak(runs, policy.countingSince, window);

  if (policy.muteUntilSuccess && summary.latestSuccessRunId) {
    await db
      .update(workflowFailureAlertOverrides)
      .set({ muteUntilSuccess: false, muteReason: null, mutedBy: null })
      .where(eq(workflowFailureAlertOverrides.workflowId, workflowId));
  }

  if (open && summary.failures > 0 && summary.lastFailedAt) {
    await db
      .update(workflowFailureIncidents)
      .set({
        failureCount: Math.max(open.failureCount, summary.failures),
        lastFailedAt: summary.lastFailedAt,
        lastFailedExecutionId: summary.lastFailedRunId,
        lastError: summary.lastError,
      })
      .where(eq(workflowFailureIncidents.id, open.id));
  }

  // Turned back on but still failing: pause it again, counting only the runs
  // since the last pause, and say so.
  if (open?.workflowPausedAt && policy.pauseWorkflow) {
    const sincePause = summarizeStreak(runs, open.workflowPausedAt, window);
    if (sincePause.failures >= policy.threshold) {
      await pauseAgain(workflow, open, policy, sincePause.failures, now, stats);
      return null;
    }
  }

  const decision = decide({
    summary,
    threshold: policy.threshold,
    timeLimitMinutes: policy.timeLimitMinutes,
    hasOpenIncident: open !== null,
    now,
  });

  if (decision.kind === "recheck") {
    return decision.at;
  }
  if (decision.kind === "resolve" && open) {
    await closeIncident({
      incident: open,
      reason: "success",
      resolvingExecutionId: summary.latestSuccessRunId,
      notifyRecovery: policy.notifyRecovery,
      now,
      stats,
    });
    return null;
  }
  if (decision.kind !== "open") {
    return null;
  }
  // A mute silences alerts, not the pause someone asked for. A workflow
  // turned off without a word would be worse than the alert, so pausing one
  // always opens the incident and tells people.
  if (isMuted(policy, now) && !policy.pauseWorkflow) {
    // Alerts start again if it is still failing when the mute ends.
    return policy.muteUntilSuccess ? null : policy.mutedUntil;
  }
  if (!(summary.firstFailedAt && summary.lastFailedAt)) {
    return null;
  }

  const inserted = await db
    .insert(workflowFailureIncidents)
    .values({
      organizationId: workflow.organizationId,
      workflowId,
      openedBy: decision.by,
      threshold: policy.threshold,
      failureCount: summary.failures,
      firstFailedAt: summary.firstFailedAt,
      lastFailedAt: summary.lastFailedAt,
      lastFailedExecutionId: summary.lastFailedRunId,
      lastError: summary.lastError,
      lastNotifiedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: workflowFailureIncidents.id });
  if (inserted[0]) {
    stats.incidentsOpened += 1;
    if (policy.pauseWorkflow) {
      // Before the alert is queued, so the alert says it was paused.
      await pauseWorkflowFor(workflow, inserted[0].id, summary.failures, now);
    }
    opened.push({
      id: inserted[0].id,
      organizationId: workflow.organizationId,
      workflowId,
    });
  }
  return null;
}

/**
 * The rows for one message to everyone the policy names. With nobody to
 * email and no chat channel, one failed email row is written so the backup
 * channels fire and the history shows nobody could be reached.
 */
export function buildMessageRows(params: {
  scope: string;
  organizationId: string;
  incidentId: string | null;
  kind: FailureAlertMessageKind;
  sequence: number;
  emails: string[];
  channels: ChannelConfig[];
  includePagerDuty: boolean;
  context?: Record<string, unknown>;
  now: Date;
}): DeliveryInsert[] {
  const base = {
    scope: params.scope,
    organizationId: params.organizationId,
    incidentId: params.incidentId,
    kind: params.kind,
    sequence: params.sequence,
    context: params.context,
    nextAttemptAt: params.now,
  };
  const backupAt = (channel: FailureAlertDeliveryChannel): Date =>
    new Date(params.now.getTime() + BACKUP_AFTER_MS[channel]);

  const rows: DeliveryInsert[] = params.emails.map((email) => ({
    ...base,
    channel: "email",
    recipient: email,
    backupAt: backupAt("email"),
  }));

  for (const channel of params.channels) {
    if (channel.pausedAt || channel.role !== "always") {
      continue;
    }
    if (channel.kind === "pagerduty" && !params.includePagerDuty) {
      continue;
    }
    rows.push({
      ...base,
      channel: channel.kind,
      channelId: channel.id,
      recipient: channelRecipient(channel),
      backupAt: backupAt(channel.kind),
    });
  }

  if (params.emails.length === 0) {
    rows.push({
      ...base,
      channel: "email",
      recipient: "(nobody reachable)",
      state: "failed",
      lastError:
        "Nobody in the organization has an email address KeeperHub can reach.",
      backupAt: params.now,
    });
  }
  return rows;
}

function rowsForPolicy(
  policy: EffectivePolicy,
  members: OrgMember[],
  organizationId: string,
  incidentId: string,
  kind: FailureAlertMessageKind,
  sequence: number,
  now: Date,
  context?: Record<string, unknown>
): DeliveryInsert[] {
  return buildMessageRows({
    scope: incidentScope(incidentId),
    organizationId,
    incidentId,
    kind,
    sequence,
    context,
    emails: resolveRecipientEmails(policy.recipientUserIds, members),
    channels: policy.channels,
    // PagerDuty owns escalation: it gets the incident and its resolve, never
    // our reminders.
    includePagerDuty: kind === "alert",
    now,
  });
}

/**
 * Pause a workflow that kept failing after someone turned it back on, and
 * tell the same people. Sent as the incident's next reminder, so the claim on
 * the reminder count keeps two evaluators from both sending it.
 */
async function pauseAgain(
  workflow: WorkflowRow,
  incident: IncidentRow,
  policy: EffectivePolicy,
  failures: number,
  now: Date,
  stats: EvaluationStats
): Promise<void> {
  if (!(await pauseWorkflowFor(workflow, incident.id, failures, now))) {
    return;
  }
  const sequence = incident.reminderCount + 1;
  const claimed = await db
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
    return;
  }
  const members = await loadOrgMembers(workflow.organizationId);
  stats.messagesQueued += await insertDeliveries(
    rowsForPolicy(
      policy,
      members,
      workflow.organizationId,
      incident.id,
      "reminder",
      sequence,
      now,
      { pausedAgain: true }
    )
  );
}

/** Queue rows and mark the incidents alerted, all or nothing. */
async function queueAndMark(
  rows: DeliveryInsert[],
  incidentIds: string[],
  now: Date
): Promise<number> {
  return await db.transaction(async (tx: Tx) => {
    const queued = await insertDeliveries(rows, tx);
    await tx
      .update(workflowFailureIncidents)
      .set({ alertQueuedAt: now })
      .where(inArray(workflowFailureIncidents.id, incidentIds));
    return queued;
  });
}

/**
 * Queue alerts for newly opened incidents. Three or more in one org at once
 * usually share a cause (an RPC outage, a wallet out of gas), so email and
 * chat get one grouped message; PagerDuty still gets one incident per
 * workflow so each resolves on its own.
 *
 * Each org's rows and the incidents' alertQueuedAt are written in one
 * transaction, so a crash leaves either both or neither; an incident left
 * without them is picked up by requeueLostAlerts.
 */
async function queueAlerts(
  opened: OpenedIncident[],
  now: Date,
  stats: EvaluationStats
): Promise<void> {
  const byOrg = new Map<string, OpenedIncident[]>();
  for (const incident of opened) {
    const list = byOrg.get(incident.organizationId) ?? [];
    list.push(incident);
    byOrg.set(incident.organizationId, list);
  }

  for (const [organizationId, incidents] of byOrg) {
    try {
      const members = await loadOrgMembers(organizationId);
      const rows: DeliveryInsert[] = [];
      if (incidents.length >= GROUP_ALERTS_FROM) {
        const org = await loadOrgPolicy(organizationId);
        const orgChannels = await loadChannels(organizationId, null);
        rows.push(
          ...buildMessageRows({
            scope: groupScope(incidents[0].id),
            organizationId,
            incidentId: null,
            kind: "alert",
            sequence: 0,
            emails: resolveRecipientEmails(org.recipientUserIds, members),
            channels: orgChannels,
            includePagerDuty: false,
            context: { incidentIds: incidents.map((i) => i.id) },
            now,
          })
        );
        for (const incident of incidents) {
          const policy = await loadEffectivePolicy(
            organizationId,
            incident.workflowId
          );
          rows.push(
            ...buildMessageRows({
              scope: incidentScope(incident.id),
              organizationId,
              incidentId: incident.id,
              kind: "alert",
              sequence: 0,
              emails: [],
              channels: policy.channels.filter((c) => c.kind === "pagerduty"),
              includePagerDuty: true,
              now,
            }).filter((row) => row.channel === "pagerduty")
          );
        }
      } else {
        for (const incident of incidents) {
          const policy = await loadEffectivePolicy(
            organizationId,
            incident.workflowId
          );
          rows.push(
            ...rowsForPolicy(
              policy,
              members,
              organizationId,
              incident.id,
              "alert",
              0,
              now
            )
          );
        }
      }
      stats.messagesQueued += await queueAndMark(
        rows,
        incidents.map((i) => i.id),
        now
      );
    } catch (error) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[FailureAlerts] Could not queue alerts; they will be re-queued",
        error,
        { organization_id: organizationId }
      );
    }
  }
}

/** Open incidents whose alert never got queued, from a crash in between. */
export async function requeueLostAlerts(
  now: Date,
  stats: EvaluationStats
): Promise<void> {
  const lost = await db
    .select({
      id: workflowFailureIncidents.id,
      organizationId: workflowFailureIncidents.organizationId,
      workflowId: workflowFailureIncidents.workflowId,
    })
    .from(workflowFailureIncidents)
    .where(
      and(
        isNull(workflowFailureIncidents.resolvedAt),
        isNull(workflowFailureIncidents.alertQueuedAt),
        lt(
          workflowFailureIncidents.openedAt,
          new Date(now.getTime() - ALERT_REQUEUE_AFTER_MS)
        )
      )
    )
    // A stable order, so two overlapping cycles group the same incidents the
    // same way and their grouped alerts share one dedup key.
    .orderBy(workflowFailureIncidents.id)
    .limit(100);
  const enabled = lost.filter((incident) =>
    isFailureAlertsEnabledForOrg(incident.organizationId)
  );
  if (enabled.length > 0) {
    await queueAlerts(enabled, now, stats);
  }
}

/**
 * Close incidents of workflows that were paused, deleted or switched to a
 * manual trigger. Those changes write no run, so nothing queues the workflow;
 * without this sweep the incident would stay open, reminders would keep
 * going and a PagerDuty page would stay triggered.
 */
export async function closeInactiveIncidents(
  now: Date,
  stats: EvaluationStats
): Promise<void> {
  const open = await db
    .select({
      incident: workflowFailureIncidents,
      enabled: workflows.enabled,
      deletedAt: workflows.deletedAt,
      deactivatedAt: workflows.deactivatedAt,
      nodes: workflows.nodes,
      name: workflows.name,
    })
    .from(workflowFailureIncidents)
    .innerJoin(workflows, eq(workflows.id, workflowFailureIncidents.workflowId))
    .where(
      and(
        isNull(workflowFailureIncidents.resolvedAt),
        // Only the inactive ones, so a long list of open incidents during a
        // wide outage cannot crowd them out of the batch. A workflow its own
        // incident paused is held open (heldByPause), so it is left out too.
        sql`((${workflows.enabled} = false AND ${workflowFailureIncidents.workflowPausedAt} IS NULL)
          OR ${workflows.deletedAt} IS NOT NULL
          OR ${workflows.deactivatedAt} IS NOT NULL
          OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(${workflows.nodes}) = 'array'
                THEN ${workflows.nodes} ELSE '[]'::jsonb END
            ) AS node
            WHERE node->'data'->>'type' = 'trigger'
              AND node->'data'->'config'->>'triggerType' IN (${sql.join(
                AUTOMATIC_TRIGGERS.map((trigger) => sql`${trigger}`),
                sql`, `
              )})
          ))`
      )
    )
    .orderBy(workflowFailureIncidents.openedAt)
    .limit(500);

  for (const row of open) {
    const workflow = {
      id: row.incident.workflowId,
      name: row.name,
      organizationId: row.incident.organizationId,
      enabled: row.enabled,
      deletedAt: row.deletedAt,
      deactivatedAt: row.deactivatedAt,
      nodes: row.nodes,
    };
    const reason = inactiveResolution(workflow, workflowTriggerType(row.nodes));
    if (!reason || heldByPause(row.incident, workflow, reason)) {
      continue;
    }
    try {
      await closeIncident({
        incident: row.incident,
        reason,
        resolvingExecutionId: null,
        notifyRecovery: false,
        now,
        stats,
      });
    } catch (error) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[FailureAlerts] Could not close an incident of an inactive workflow",
        error,
        { incident_id: row.incident.id }
      );
    }
  }
}

/**
 * Daily reminders while a workflow keeps failing. Claimed with a compare and
 * set on the reminder count, so two evaluators never both send one.
 */
export async function queueReminders(
  now: Date,
  stats: EvaluationStats
): Promise<void> {
  const due = await db
    .select()
    .from(workflowFailureIncidents)
    .where(
      and(
        isNull(workflowFailureIncidents.resolvedAt),
        lte(
          workflowFailureIncidents.lastNotifiedAt,
          new Date(now.getTime() - REMINDER_INTERVAL_MS)
        ),
        lt(workflowFailureIncidents.reminderCount, MAX_REMINDERS)
      )
    )
    .orderBy(workflowFailureIncidents.lastNotifiedAt)
    .limit(100);

  for (const incident of due) {
    try {
      const policy = isFailureAlertsEnabledForOrg(incident.organizationId)
        ? await loadEffectivePolicy(
            incident.organizationId,
            incident.workflowId
          )
        : null;
      // A workflow its incident paused is not "still failing": it is off.
      const pausedByUs =
        incident.workflowPausedAt !== null &&
        !(await loadWorkflow(incident.workflowId))?.enabled;
      if (!policy?.remindDaily || isMuted(policy, now) || pausedByUs) {
        // Not owed a reminder today. Move its clock on without counting one,
        // so it leaves the due list instead of crowding out other orgs'.
        await db
          .update(workflowFailureIncidents)
          .set({ lastNotifiedAt: now })
          .where(eq(workflowFailureIncidents.id, incident.id));
        continue;
      }
      const sequence = incident.reminderCount + 1;
      const claimed = await db
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
        continue;
      }
      const members = await loadOrgMembers(incident.organizationId);
      stats.messagesQueued += await insertDeliveries(
        rowsForPolicy(
          policy,
          members,
          incident.organizationId,
          incident.id,
          "reminder",
          sequence,
          now
        )
      );
      stats.remindersQueued += 1;
    } catch (error) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[FailureAlerts] Could not queue a reminder",
        error,
        { incident_id: incident.id }
      );
    }
  }
}

/**
 * The one-time "notifications are on" email for an organization that already
 * had workflows running before the feature reached it, listing the workflows
 * failing right now so nobody learns about them weeks later. Claimed by
 * setting launchNoticeSentAt, so it goes out once however the settings row
 * came to exist.
 */
async function queueLaunchNotice(
  organizationId: string,
  now: Date,
  stats: EvaluationStats
): Promise<void> {
  const claimed = await db
    .update(orgFailureAlertSettings)
    .set({ launchNoticeSentAt: now })
    .where(
      and(
        eq(orgFailureAlertSettings.organizationId, organizationId),
        isNull(orgFailureAlertSettings.launchNoticeSentAt)
      )
    )
    .returning({ organizationId: orgFailureAlertSettings.organizationId });
  if (claimed.length === 0) {
    return;
  }

  const [earlier] = await db
    .select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.organizationId, organizationId),
        lt(workflowExecutions.startedAt, new Date(now.getTime() - 60_000))
      )
    )
    .limit(1);
  if (!earlier) {
    return;
  }

  const failingNow = await findFailingWorkflows(organizationId);
  const owners = resolveRecipientEmails(
    null,
    await loadOrgMembers(organizationId)
  );
  stats.messagesQueued += await insertDeliveries(
    owners.map((email) => ({
      scope: `launch:${organizationId}`,
      organizationId,
      incidentId: null,
      kind: "launch_notice" as const,
      sequence: 0,
      channel: "email" as const,
      recipient: email,
      nextAttemptAt: now,
      context: { failingNow },
    }))
  );
}

const LAUNCH_SCAN_LIMIT = 200;

async function findFailingWorkflows(organizationId: string): Promise<
  {
    id: string;
    name: string;
    triggerLabel: string;
    failureCount: number;
  }[]
> {
  const candidates = await db
    .select({ id: workflows.id, name: workflows.name, nodes: workflows.nodes })
    .from(workflows)
    .where(
      and(
        eq(workflows.organizationId, organizationId),
        eq(workflows.enabled, true),
        isNull(workflows.deletedAt),
        isNull(workflows.deactivatedAt)
      )
    )
    .limit(LAUNCH_SCAN_LIMIT);

  const failing: {
    id: string;
    name: string;
    triggerLabel: string;
    failureCount: number;
  }[] = [];
  for (const candidate of candidates) {
    const trigger = workflowTriggerType(candidate.nodes);
    if (!(trigger && runsOnItsOwn(trigger))) {
      continue;
    }
    const runs = await loadRecentRuns(
      candidate.id,
      DEFAULT_THRESHOLD * STREAK_WINDOW_MULTIPLIER
    );
    const summary = summarizeStreak(runs, null, runs.length + 1);
    if (summary.failures >= DEFAULT_THRESHOLD) {
      failing.push({
        id: candidate.id,
        name: candidate.name,
        triggerLabel: trigger,
        failureCount: summary.failures,
      });
    }
  }
  return failing;
}

/** Drain the queue of workflows to evaluate and queue the resulting alerts. */
export async function evaluateQueuedWorkflows(
  now: Date,
  stats: EvaluationStats
): Promise<void> {
  const claimed = await claimQueue();
  const opened: OpenedIncident[] = [];
  for (const { workflowId, lease } of claimed) {
    try {
      const recheckAt = await evaluateWorkflow(workflowId, now, opened, stats);
      await releaseQueue(workflowId, lease, recheckAt);
    } catch (error) {
      // The lease is left in place, so the workflow comes back in five
      // minutes instead of being dropped.
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[FailureAlerts] Could not evaluate workflow",
        error,
        { workflow_id: workflowId }
      );
    }
  }
  await queueAlerts(opened, now, stats);
}
