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
  BACKUP_AFTER_MS,
  DEFAULT_THRESHOLD,
  GROUP_ALERTS_FROM,
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
  loadOrgMembers,
  loadOrgPolicy,
  resolveRecipientEmails,
} from "./policy";
import { isFailureAlertsEnabledForOrg } from "./rollout";
import { decide, type StreakRun, summarizeStreak } from "./streak";

/** Reminders stop after a week; the in-app notice and Runs still show it. */
export const MAX_REMINDERS = 7;

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
  // biome-ignore lint/suspicious/noExplicitAny: workflow nodes are JSONB validated at application level
  nodes: any[];
};

export type OpenedIncident = {
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

/** The trigger configured on the workflow's trigger node, e.g. "Schedule". */
export function workflowTriggerType(
  // biome-ignore lint/suspicious/noExplicitAny: workflow nodes are JSONB validated at application level
  nodes: any[]
): string | null {
  const trigger = nodes.find((node) => node?.data?.type === "trigger");
  const value = trigger?.data?.config?.triggerType;
  return typeof value === "string" ? value : null;
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
): Promise<typeof workflowFailureIncidents.$inferSelect | null> {
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

async function resolveIncident(
  incidentId: string,
  reason: FailureIncidentResolution,
  resolvingExecutionId: string | null
): Promise<boolean> {
  const updated = await db
    .update(workflowFailureIncidents)
    .set({
      resolvedAt: new Date(),
      resolvedReason: reason,
      resolvingExecutionId,
    })
    .where(
      and(
        eq(workflowFailureIncidents.id, incidentId),
        isNull(workflowFailureIncidents.resolvedAt)
      )
    )
    .returning({ id: workflowFailureIncidents.id });
  if (updated.length > 0) {
    // Anything still waiting to go out about this streak is moot now.
    await db
      .update(failureAlertDeliveries)
      .set({
        state: "skipped",
        lastError: "The workflow recovered before this was delivered.",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(failureAlertDeliveries.incidentId, incidentId),
          inArray(failureAlertDeliveries.state, ["pending", "retrying"])
        )
      );
  }
  return updated.length > 0;
}

/**
 * Evaluate one workflow. Returns when it should be looked at again without a
 * new run (the time limit or a mute ending), or null.
 */
export async function evaluateWorkflow(
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
  const trigger = workflowTriggerType(workflow.nodes);
  const inactiveReason = inactiveResolution(workflow, trigger);
  if (inactiveReason) {
    if (open && (await resolveIncident(open.id, inactiveReason, null))) {
      stats.incidentsResolved += 1;
    }
    return null;
  }

  if (await ensureOrgSettings(workflow.organizationId, now)) {
    await queueLaunchNotice(workflow.organizationId, now, stats);
  }

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
    if (await resolveIncident(open.id, "success", summary.latestSuccessRunId)) {
      stats.incidentsResolved += 1;
      if (policy.notifyRecovery) {
        stats.messagesQueued += await queueRecovery(open.id, now);
      }
    }
    return null;
  }
  if (decision.kind !== "open") {
    return null;
  }
  if (isMuted(policy, now)) {
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
    opened.push({
      id: inserted[0].id,
      organizationId: workflow.organizationId,
      workflowId,
    });
  }
  return null;
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
  if (!trigger || trigger === "Manual") {
    return "manual_trigger";
  }
  return null;
}

type QueuedRow = typeof failureAlertDeliveries.$inferInsert;

async function insertDeliveries(rows: QueuedRow[]): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  const inserted = await db
    .insert(failureAlertDeliveries)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: failureAlertDeliveries.id });
  return inserted.length;
}

/**
 * The rows for one message to everyone the policy names. With nobody to
 * email and no chat channel, one failed email row is written so the backup
 * channels fire and the history shows nobody could be reached.
 */
export function buildMessageRows(params: {
  organizationId: string;
  incidentId: string | null;
  kind: FailureAlertMessageKind;
  sequence: number;
  emails: string[];
  channels: ChannelConfig[];
  includePagerDuty: boolean;
  context?: Record<string, unknown>;
  now: Date;
}): QueuedRow[] {
  const base = {
    organizationId: params.organizationId,
    incidentId: params.incidentId,
    kind: params.kind,
    sequence: params.sequence,
    context: params.context,
    nextAttemptAt: params.now,
  };
  const backupAt = (channel: FailureAlertDeliveryChannel): Date =>
    new Date(params.now.getTime() + BACKUP_AFTER_MS[channel]);

  const rows: QueuedRow[] = params.emails.map((email) => ({
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
      recipient: channel.destination || channel.kind,
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

/**
 * Queue alerts for the incidents this cycle opened. Three or more in one org
 * at once usually share a cause (an RPC outage, a wallet out of gas), so
 * email and chat get one grouped message; PagerDuty still gets one incident
 * per workflow so each resolves on its own.
 */
export async function queueAlerts(
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
      if (incidents.length >= GROUP_ALERTS_FROM) {
        const org = await loadOrgPolicy(organizationId);
        const orgChannels = await loadChannels(organizationId, null);
        stats.messagesQueued += await insertDeliveries(
          buildMessageRows({
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
          stats.messagesQueued += await insertDeliveries(
            buildMessageRows({
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
        continue;
      }
      for (const incident of incidents) {
        const policy = await loadEffectivePolicy(
          organizationId,
          incident.workflowId
        );
        stats.messagesQueued += await insertDeliveries(
          rowsForPolicy(
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
    } catch (error) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[FailureAlerts] Could not queue alerts",
        error,
        { organization_id: organizationId }
      );
    }
  }
}

function rowsForPolicy(
  policy: EffectivePolicy,
  members: Awaited<ReturnType<typeof loadOrgMembers>>,
  organizationId: string,
  incidentId: string,
  kind: FailureAlertMessageKind,
  sequence: number,
  now: Date
): QueuedRow[] {
  return buildMessageRows({
    organizationId,
    incidentId,
    kind,
    sequence,
    emails: resolveRecipientEmails(policy.recipientUserIds, members),
    channels: policy.channels,
    // PagerDuty owns escalation: it gets the incident and its resolve, never
    // our reminders.
    includePagerDuty: kind === "alert",
    now,
  });
}

/**
 * Tell everyone who got the alert that it is over. Only destinations the
 * alert actually reached get a recovery; PagerDuty gets a resolve on the same
 * key.
 */
async function queueRecovery(incidentId: string, now: Date): Promise<number> {
  const prior = await db
    .select({
      organizationId: failureAlertDeliveries.organizationId,
      channel: failureAlertDeliveries.channel,
      channelId: failureAlertDeliveries.channelId,
      recipient: failureAlertDeliveries.recipient,
    })
    .from(failureAlertDeliveries)
    .where(
      and(
        sql`(${failureAlertDeliveries.incidentId} = ${incidentId} OR ${failureAlertDeliveries.context} @> ${JSON.stringify({ incidentIds: [incidentId] })}::jsonb)`,
        inArray(failureAlertDeliveries.kind, ["alert", "reminder"]),
        eq(failureAlertDeliveries.state, "delivered")
      )
    );

  const seen = new Set<string>();
  const rows: QueuedRow[] = [];
  for (const row of prior) {
    const key = `${row.channel}:${row.channelId ?? ""}:${row.recipient}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    rows.push({
      organizationId: row.organizationId,
      incidentId,
      kind: "recovery",
      sequence: 0,
      channel: row.channel,
      channelId: row.channelId,
      recipient: row.recipient,
      nextAttemptAt: now,
    });
  }
  return await insertDeliveries(rows);
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
    .limit(100);

  for (const incident of due) {
    try {
      if (!isFailureAlertsEnabledForOrg(incident.organizationId)) {
        continue;
      }
      const policy = await loadEffectivePolicy(
        incident.organizationId,
        incident.workflowId
      );
      if (!policy.remindDaily || isMuted(policy, now)) {
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
      const queued = await insertDeliveries(
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
      stats.messagesQueued += queued;
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
 * failing right now so nobody learns about them weeks later.
 */
async function queueLaunchNotice(
  organizationId: string,
  now: Date,
  stats: EvaluationStats
): Promise<void> {
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
  const members = await loadOrgMembers(organizationId);
  const owners = resolveRecipientEmails(null, members);
  const queued = await insertDeliveries(
    owners.map((email) => ({
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
  stats.messagesQueued += queued;
  await db
    .update(orgFailureAlertSettings)
    .set({ launchNoticeSentAt: now })
    .where(eq(orgFailureAlertSettings.organizationId, organizationId));
}

const LAUNCH_SCAN_LIMIT = 200;

async function findFailingWorkflows(
  organizationId: string
): Promise<
  { id: string; name: string; triggerLabel: string; failureCount: number }[]
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
    if (!trigger || trigger === "Manual") {
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
