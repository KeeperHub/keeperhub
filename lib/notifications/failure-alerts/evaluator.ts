import "server-only";

import {
  and,
  desc,
  eq,
  gt,
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
  organization,
  orgFailureAlertSettings,
  workflowExecutions,
  workflowFailureAlertOverrides,
  workflowFailureAlertQueue,
  workflowFailureIncidents,
  workflowSchedules,
  workflows,
} from "@/lib/db/schema";
import type { FailureIncidentResolution } from "@/lib/db/schema-failure-alerts";
import { ErrorCategory, logSystemError, logSystemWarn } from "@/lib/logging";
import { loadOrgMembers } from "@/lib/notifications/org-recipients";
import { workflowExecutableConditions } from "@/lib/workflow/executable";
import type { TriggerNodeLike } from "@/lib/workflow/trigger-display-key";
import {
  ALERT_REQUEUE_AFTER_MS,
  DEFAULT_THRESHOLD,
  GROUP_ALERTS_FROM,
  MAX_REMINDERS,
  MAX_WORKFLOWS_PER_RUN,
  MISSED_RUNS_PLATFORM_ALERT,
  MISSED_SCAN_LIMIT,
  REMINDER_INTERVAL_MS,
} from "./constants";
import { missedDueAt, ranRecentlyCutoff } from "./missed-runs";
import { activePause } from "./org-pause";
import {
  HELD_SQL,
  heldByPause,
  isHeld,
  pauseOpenIncident,
  recordPause,
  turnOffForIncident,
} from "./pause";
import {
  type EffectivePolicy,
  ensureOrgSettings,
  isMuted,
  loadChannels,
  loadEffectivePolicy,
  loadOrgPolicy,
  resolveRecipientEmails,
} from "./policy";
import {
  buildMessageRows,
  type DeliveryInsert,
  groupScope,
  incidentScope,
  insertDeliveries,
  rowsForPolicy,
  type Tx,
} from "./queue-rows";
import { isFailureAlertsEnabledForOrg } from "./rollout";
import {
  decide,
  isAutomatedRun,
  type StreakRun,
  summarizeStreak,
} from "./streak";
import {
  AUTOMATIC_TRIGGERS,
  runsOnItsOwn,
  workflowTriggerType,
} from "./workflow-trigger";

const MIN_STREAK_WINDOW = 10;
const STREAK_WINDOW_MULTIPLIER = 4;
const LEASE = sql`now() + interval '5 minutes'`;
/** isAutomatedRun in SQL: a person's run never says a schedule is working. */
const AUTOMATED_RUN_SQL = sql`(${workflowExecutions.triggerSource} IS DISTINCT FROM 'manual'
  OR ${workflowExecutions.triggeredByCredentialType} <> 'session')`;

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
  /** Its workflow was turned off as the incident opened. */
  workflowPaused?: boolean;
  /** Org-wide pause: the alert waits until the pause ends. */
  holdUntil?: Date;
};

export type EvaluationStats = {
  workflowsEvaluated: number;
  incidentsOpened: number;
  incidentsResolved: number;
  remindersQueued: number;
  messagesQueued: number;
  schedulesLate: number;
};

export function emptyStats(): EvaluationStats {
  return {
    workflowsEvaluated: 0,
    incidentsOpened: 0,
    incidentsResolved: 0,
    remindersQueued: 0,
    messagesQueued: 0,
    schedulesLate: 0,
  };
}

/** Claim due workflows with a five-minute lease, kept as Postgres text (a raw Date parses as local time). */
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
    // ISO string: the raw sql template sends a Date as local-time text.
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

const SKIPPED_BECAUSE: Record<FailureIncidentResolution, string> = {
  success: "The workflow recovered before this was delivered.",
  ran: "The workflow ran before this was delivered.",
  disabled: "The workflow was paused before this was delivered.",
  deleted: "The workflow was deleted before this was delivered.",
  manual_trigger:
    "The workflow was switched to a manual trigger before this was delivered.",
};

/** Close an incident: a page is always resolved; email and chat hear only a wanted recovery. */
async function closeIncident(params: {
  incident: IncidentRow;
  reason: FailureIncidentResolution;
  resolvingExecutionId: string | null;
  notifyRecovery: boolean;
  now: Date;
  stats: EvaluationStats;
  /** Extra context for the recovery message (e.g. the run that ended it failed). */
  recoveryContext?: Record<string, unknown>;
}): Promise<void> {
  const { incident, reason, now, stats } = params;
  // One transaction, or a closed incident could leave its page open forever.
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
    const wantRecovery =
      (reason === "success" || reason === "ran") && params.notifyRecovery;
    for (const row of prior) {
      const pagerDuty = row.channel === "pagerduty";
      // Delay the resolve so it lands after a page still in flight.
      const inFlight = pagerDuty && row.state === "sending";
      // A timed-out page may have landed; resolving an unknown key is harmless.
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
        context: params.recoveryContext,
        nextAttemptAt: inFlight ? new Date(now.getTime() + 2 * 60 * 1000) : now,
      });
    }
    stats.messagesQueued += await insertDeliveries(rows, tx);
  });
}

const LAUNCH_SCANS_PER_CYCLE = 20;
const cycles = new WeakMap<
  EvaluationStats,
  { orgsSeen: Set<string>; launchScans: number }
>();

/** Per-cycle bookkeeping, keyed by the cycle's stats object. */
function cycleState(stats: EvaluationStats): {
  orgsSeen: Set<string>;
  launchScans: number;
} {
  let state = cycles.get(stats);
  if (!state) {
    state = { orgsSeen: new Set(), launchScans: 0 };
    cycles.set(stats, state);
  }
  return state;
}

/** Evaluate one workflow; returns when to recheck without a new run, or null. */
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

  // Once per org per cycle: on rollout day thousands of runs share a few orgs.
  const cycle = cycleState(stats);
  if (!cycle.orgsSeen.has(workflow.organizationId)) {
    cycle.orgsSeen.add(workflow.organizationId);
    await ensureOrgSettings(workflow.organizationId, now);
    await queueLaunchNotice(workflow.organizationId, now, stats);
  }

  const policy = await loadEffectivePolicy(workflow.organizationId, workflowId);
  const orgPause = activePause(policy.orgPausedUntil, now);
  const window = Math.max(
    MIN_STREAK_WINDOW,
    policy.threshold * STREAK_WINDOW_MULTIPLIER
  );
  const runs = await loadRecentRuns(workflowId, window);
  const summary = summarizeStreak(runs, policy.countingSince, window);

  // A late schedule's incident ends with any run; failures then count as usual.
  if (open?.openedBy === "missed") {
    const ranAgain = runs.find(
      (run) => isAutomatedRun(run) && run.startedAt > open.firstFailedAt
    );
    if (ranAgain) {
      await closeIncident({
        incident: open,
        reason: "ran",
        resolvingExecutionId: ranAgain.id,
        notifyRecovery: policy.notifyRecovery,
        now,
        stats,
        recoveryContext:
          ranAgain.status === "error" ? { ranButFailed: true } : undefined,
      });
      // Now closed: the run that ended it may itself start a failing streak.
      return await evaluateWorkflow(workflowId, now, opened, stats);
    }
    return null;
  }

  if (policy.muteUntilSuccess && summary.latestSuccessRunId) {
    await db
      .update(workflowFailureAlertOverrides)
      .set({
        muteUntilSuccess: false,
        mutedUntil: null,
        muteReason: null,
        mutedBy: null,
        version: sql`${workflowFailureAlertOverrides.version} + 1`,
      })
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

  // Pause box ticked after the alert, or re-enabled and still failing (runs
  // since the last pause count).
  if (open && policy.pauseWorkflow) {
    const since = open.workflowPausedAt;
    const streak = since ? summarizeStreak(runs, since, window) : summary;
    if (streak.failures >= policy.threshold) {
      stats.messagesQueued += await pauseOpenIncident({
        workflow,
        incident: open,
        policy,
        failures: streak.failures,
        again: since !== null,
        now,
        holdUntil: orgPause ?? undefined,
      });
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
      notifyRecovery: policy.notifyRecovery && !orgPause,
      now,
      stats,
    });
    return null;
  }
  if (decision.kind !== "open") {
    return null;
  }
  // An org pause holds alerts but still turns the workflow off (it may spend gas).
  if (orgPause && !policy.pauseWorkflow) {
    return orgPause;
  }
  // A mute never hides a pause: turning a workflow off silently is worse.
  if (isMuted(policy, now) && !policy.pauseWorkflow) {
    // Alerts start again if it is still failing when the mute ends.
    return policy.mutedUntil;
  }
  if (!(summary.firstFailedAt && summary.lastFailedAt)) {
    return null;
  }

  const { firstFailedAt, lastFailedAt } = summary;
  // One transaction, so the incident never exists without its pause.
  const result = await db.transaction(async (tx: Tx) => {
    const [row] = await tx
      .insert(workflowFailureIncidents)
      .values({
        organizationId: workflow.organizationId,
        workflowId,
        openedBy: decision.by,
        threshold: policy.threshold,
        failureCount: summary.failures,
        firstFailedAt,
        lastFailedAt,
        lastFailedExecutionId: summary.lastFailedRunId,
        lastError: summary.lastError,
        lastNotifiedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: workflowFailureIncidents.id });
    if (!row) {
      return null;
    }
    const paused =
      policy.pauseWorkflow &&
      (await turnOffForIncident(tx, workflowId, row.id, now));
    return { id: row.id, paused };
  });
  if (result) {
    stats.incidentsOpened += 1;
    if (result.paused) {
      await recordPause(workflow, result.id, summary.failures);
    }
    opened.push({
      id: result.id,
      organizationId: workflow.organizationId,
      workflowId,
      workflowPaused: result.paused,
      holdUntil: orgPause ?? undefined,
    });
  }
  return null;
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

/** 3+ alerts in one org usually share a cause: group email/chat, keep PagerDuty per workflow. */
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
      const policies = new Map<string, EffectivePolicy>();
      for (const incident of incidents) {
        policies.set(
          incident.id,
          await loadEffectivePolicy(organizationId, incident.workflowId)
        );
      }
      // Only org-following workflows group; held alerts (org pause) go out later.
      const groupable = incidents.filter(
        (i) => !(policies.get(i.id)?.customRouting || i.holdUntil)
      );
      const grouped = groupable.length >= GROUP_ALERTS_FROM ? groupable : [];
      if (grouped.length > 0) {
        const org = await loadOrgPolicy(organizationId);
        const orgChannels = await loadChannels(organizationId, null);
        rows.push(
          ...buildMessageRows({
            scope: groupScope(grouped[0].id),
            organizationId,
            incidentId: null,
            kind: "alert",
            sequence: 0,
            emails: resolveRecipientEmails(org.recipientUserIds, members),
            channels: orgChannels,
            includePagerDuty: false,
            context: { incidentIds: grouped.map((i) => i.id) },
            now,
          })
        );
        for (const incident of grouped) {
          const policy = policies.get(incident.id);
          rows.push(
            ...buildMessageRows({
              scope: incidentScope(incident.id),
              organizationId,
              incidentId: incident.id,
              kind: "alert",
              sequence: 0,
              emails: [],
              channels: (policy?.channels ?? []).filter(
                (c) => c.kind === "pagerduty"
              ),
              includePagerDuty: true,
              context: { group: groupScope(grouped[0].id) },
              now,
            }).filter((row) => row.channel === "pagerduty")
          );
        }
      }
      for (const incident of incidents) {
        const policy = policies.get(incident.id);
        if (grouped.includes(incident) || !policy) {
          continue;
        }
        rows.push(
          ...rowsForPolicy(
            policy,
            members,
            organizationId,
            incident.id,
            "alert",
            0,
            incident.holdUntil ?? now,
            incident.workflowPaused ? { workflowPaused: true } : undefined
          )
        );
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
    // Stable order, so overlapping cycles produce the same group dedup key.
    .orderBy(workflowFailureIncidents.id)
    .limit(100);
  const enabled: OpenedIncident[] = [];
  const pauses = new Map<string, Date | null>();
  for (const incident of lost) {
    if (!isFailureAlertsEnabledForOrg(incident.organizationId)) {
      continue;
    }
    if (!pauses.has(incident.organizationId)) {
      const org = await loadOrgPolicy(incident.organizationId);
      pauses.set(incident.organizationId, activePause(org.pausedUntil, now));
    }
    // Held like any alert during an org pause.
    enabled.push({
      ...incident,
      holdUntil: pauses.get(incident.organizationId) ?? undefined,
    });
  }
  if (enabled.length > 0) {
    await queueAlerts(enabled, now, stats);
  }
}

/** Close incidents of paused, deleted or manual workflows: no run ever queues them. */
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
        // Filter in SQL so a wide outage cannot crowd them out; heldByPause stays open.
        sql`((${workflows.enabled} = false AND NOT ${HELD_SQL})
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

/** Daily reminders; compare-and-set on the count so only one evaluator sends. */
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
      if (
        !policy?.remindDaily ||
        isMuted(policy, now) ||
        isHeld(incident) ||
        activePause(policy.orgPausedUntil, now)
      ) {
        // Not owed today: move its clock so it stops crowding the due list.
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

/** One-time launch notice listing workflows already failing; launchNoticeSentAt claims it. */
async function queueLaunchNotice(
  organizationId: string,
  now: Date,
  stats: EvaluationStats
): Promise<void> {
  // The scan below is heavy: a few orgs per cycle, the rest next time.
  const cycle = cycleState(stats);
  if (cycle.launchScans >= LAUNCH_SCANS_PER_CYCLE) {
    return;
  }
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
  cycle.launchScans += 1;

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

/** Where the missed-run scan stopped, so each cycle covers the next slice. */
let missedScanCursor: string | null = null;
/** A scheduler outage is ours: customers hear only once it lasts this long. */
const PLATFORM_HOLD_MS = 30 * 60 * 1000;

/** Schedules past due plus grace with no run since; many at once pages our team. */
export async function checkMissedSchedules(
  now: Date,
  stats: EvaluationStats
): Promise<void> {
  const candidates = await db
    .select({
      scheduleId: workflowSchedules.id,
      workflowId: workflows.id,
      organizationId: workflows.organizationId,
      nodes: workflows.nodes,
      cronExpression: workflowSchedules.cronExpression,
      timezone: workflowSchedules.timezone,
      intervalSeconds: workflowSchedules.intervalSeconds,
      anchorAt: workflowSchedules.anchorAt,
      scheduleCreatedAt: workflowSchedules.createdAt,
      lastStartedAt: sql`(SELECT max(${workflowExecutions.startedAt})
        FROM ${workflowExecutions}
        WHERE ${workflowExecutions.workflowId} = ${workflows.id}
          AND ${AUTOMATED_RUN_SQL})`.mapWith(workflowExecutions.startedAt),
    })
    .from(workflowSchedules)
    .innerJoin(workflows, eq(workflows.id, workflowSchedules.workflowId))
    .innerJoin(organization, eq(organization.id, workflows.organizationId))
    .where(
      and(
        eq(workflowSchedules.enabled, true),
        workflowExecutableConditions(),
        missedScanCursor
          ? gt(workflowSchedules.id, missedScanCursor)
          : undefined,
        sql`NOT EXISTS (SELECT 1 FROM ${workflowExecutions}
          WHERE ${workflowExecutions.workflowId} = ${workflows.id}
            AND ${workflowExecutions.startedAt} >= ${ranRecentlyCutoff(now).toISOString()}
            AND ${AUTOMATED_RUN_SQL})`,
        sql`NOT EXISTS (SELECT 1 FROM ${workflowFailureIncidents}
          WHERE ${workflowFailureIncidents.workflowId} = ${workflows.id}
            AND ${workflowFailureIncidents.resolvedAt} IS NULL)`
      )
    )
    .orderBy(workflowSchedules.id)
    .limit(MISSED_SCAN_LIMIT);
  missedScanCursor =
    candidates.length < MISSED_SCAN_LIMIT
      ? null
      : (candidates.at(-1)?.scheduleId ?? null);

  // Every org counts toward an outage; only rolled-out orgs hear about it.
  const lateAnywhere = candidates.filter(
    (row) =>
      workflowTriggerType(row.nodes) === "Schedule" &&
      missedDueAt({
        schedule: row,
        lastStartedAt: row.lastStartedAt,
        notBefore: row.scheduleCreatedAt,
        now,
      }) !== null
  );
  stats.schedulesLate += lateAnywhere.length;
  const platformWide =
    lateAnywhere.length >= MISSED_RUNS_PLATFORM_ALERT &&
    new Set(lateAnywhere.map((row) => row.organizationId)).size >= 3;
  if (platformWide) {
    logSystemError(
      ErrorCategory.WORKFLOW_ENGINE,
      "[FailureAlerts] Many scheduled workflows have not run; the scheduler may be down",
      new Error(`${lateAnywhere.length} schedules late`),
      { late: String(lateAnywhere.length) }
    );
  }

  const counting = new Map<string, Date | null>();
  const late: ((typeof candidates)[number] & { dueAt: Date })[] = [];
  for (const row of lateAnywhere) {
    if (!isFailureAlertsEnabledForOrg(row.organizationId)) {
      continue;
    }
    if (!counting.has(row.organizationId)) {
      counting.set(
        row.organizationId,
        (await loadOrgPolicy(row.organizationId)).countingSince
      );
    }
    // A new org starts counting now, so nothing before this cycle is "late".
    const since = counting.get(row.organizationId) ?? now;
    const dueAt = missedDueAt({
      schedule: row,
      lastStartedAt: row.lastStartedAt,
      notBefore: new Date(
        Math.max(since.getTime(), row.scheduleCreatedAt.getTime())
      ),
      now,
    });
    if (dueAt) {
      late.push({ ...row, dueAt });
    }
  }

  const opened: OpenedIncident[] = [];
  for (const row of late) {
    if (
      platformWide &&
      now.getTime() - row.dueAt.getTime() < PLATFORM_HOLD_MS
    ) {
      continue;
    }
    try {
      await ensureOrgSettings(row.organizationId, now);
      const policy = await loadEffectivePolicy(
        row.organizationId,
        row.workflowId
      );
      if (isMuted(policy, now) || activePause(policy.orgPausedUntil, now)) {
        continue;
      }
      const [inserted] = await db
        .insert(workflowFailureIncidents)
        .values({
          organizationId: row.organizationId,
          workflowId: row.workflowId,
          openedBy: "missed",
          threshold: policy.threshold,
          failureCount: 0,
          firstFailedAt: row.dueAt,
          lastFailedAt: row.dueAt,
          lastNotifiedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: workflowFailureIncidents.id });
      if (inserted) {
        stats.incidentsOpened += 1;
        opened.push({
          id: inserted.id,
          organizationId: row.organizationId,
          workflowId: row.workflowId,
        });
        // The message tells customers our team is alerted: make it true.
        logSystemWarn(
          ErrorCategory.WORKFLOW_ENGINE,
          "[FailureAlerts] A scheduled run did not start",
          new Error(`due at ${row.dueAt.toISOString()}`),
          { workflow_id: row.workflowId, organization_id: row.organizationId }
        );
      }
    } catch (error) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[FailureAlerts] Could not check a schedule for a missed run",
        error,
        { workflow_id: row.workflowId }
      );
    }
  }
  await queueAlerts(opened, now, stats);
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
      // Leave the lease, so the workflow returns in five minutes.
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
