import "server-only";

import {
  and,
  desc,
  eq,
  gt,
  gte,
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
  workflowFailureAlertQueue,
  workflowFailureIncidents,
  workflowSchedules,
  workflows,
} from "@/lib/db/schema";
import type { FailureIncidentResolution } from "@/lib/db/schema-failure-alerts";
import type { Tx } from "@/lib/db/tx";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { ErrorCategory, logSystemError, logSystemWarn } from "@/lib/logging";
import {
  loadOrgMembers,
  type OrgMember,
} from "@/lib/notifications/org-recipients";
import { workflowExecutableConditions } from "@/lib/workflow/executable";
import { acceptedRunSql } from "@/lib/workflow/refused-runs";
import { WorkflowTriggerEnum } from "@/lib/workflow/store";
import type { TriggerNodeLike } from "@/lib/workflow/trigger-display-key";
import {
  ALERT_REQUEUE_AFTER_MS,
  BACKUP_AFTER_MS,
  DEFAULT_THRESHOLD,
  DIGEST_PULL_IN_MS,
  EVALUATE_BUDGET_MS,
  GROUP_ALERTS_FROM,
  MAX_REMINDERS,
  MAX_WORKFLOWS_PER_RUN,
  MISSED_RUNS_PLATFORM_ALERT,
  MISSED_SCAN_LIMIT,
  OUT_OF_FUNDS_THRESHOLD,
  PAGERDUTY_IN_FLIGHT_MS,
  RECOVERY_HOLD_MS,
  REFUSAL_RECENT_MS,
  REFUSALS_STOPPED_MS,
  REFUSED_RUNS_THRESHOLD,
  REMINDER_INTERVAL_MS,
} from "./constants";
import { missedDueAt, ranRecentlyCutoff } from "./missed-runs";
import { endMuteBecauseItWorks } from "./mute-notices";
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
} from "./queue-rows";
import { isFailureAlertsEnabledForOrg, splitByRollout } from "./rollout";
import { lockOrgSettings } from "./settings";
import { SKIP_REASON } from "./stored-reasons";
import { decide, summarizeStreak } from "./streak";
import {
  AUTOMATED_RUN_SQL,
  beforeBucket,
  loadNewestRefusal,
  loadRefusalStreak,
  loadStreakRuns,
  REFUSED_RUN_SQL,
  type RefusedRun,
} from "./streak-runs";
import { isRefusedIncident } from "./view-types";
import {
  AUTOMATIC_TRIGGERS,
  runsOnItsOwn,
  workflowTriggerType,
} from "./workflow-trigger";

const MIN_STREAK_WINDOW = 10;
const STREAK_WINDOW_MULTIPLIER = 4;
const LEASE = sql`now() + interval '5 minutes'`;
/** A run that counts as the workflow running: automated, not deleted, not refused before it started. */
const COUNTED_RUN_SQL = sql`(${AUTOMATED_RUN_SQL}
  AND ${workflowExecutions.deletedAt} IS NULL
  AND NOT ${REFUSED_RUN_SQL})`;
/** A counted run a worker actually picked up; a placeholder or queued row has not started. */
const STARTED_RUN_SQL = sql`(${COUNTED_RUN_SQL}
  AND ${workflowExecutions.status} NOT IN ('phantom', 'pending'))`;

type WorkflowRow = {
  id: string;
  name: string;
  organizationId: string;
  enabled: boolean;
  deletedAt: Date | null;
  deactivatedAt: Date | null;
  nodes: TriggerNodeLike[];
  /** A deactivated or halted org runs nothing, whatever its workflows say. */
  orgDeactivatedAt: Date | null;
  orgHaltedAt: Date | null;
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
  /** Refused: always its own alert, never in a grouped one. */
  refused?: boolean;
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

/** One claim's rows share its lease, kept as Postgres text (a raw Date parses as local time). */
type Claimed = { workflowId: string; lease: string };

/** Claim due workflows with a five-minute lease, skipping ones this cycle already took. */
async function claimQueue(skip: ReadonlySet<string>): Promise<Claimed[]> {
  const notSkipped =
    skip.size > 0
      ? sql`AND workflow_id NOT IN (${sql.join(
          [...skip].map((id) => sql`${id}`),
          sql`, `
        )})`
      : sql``;
  const rows = await db.execute<{ workflow_id: string; lease: string }>(sql`
    UPDATE ${workflowFailureAlertQueue}
    SET due_at = ${LEASE}
    WHERE workflow_id IN (
      SELECT workflow_id FROM ${workflowFailureAlertQueue}
      WHERE due_at <= now() ${notSkipped}
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

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  );

/** Drop claimed rows of orgs outside the rollout (or gone) in bulk, keeping the rest. */
async function dropOutsideRollout(
  claimed: Claimed[],
  lease: string
): Promise<Claimed[]> {
  if (claimed.length === 0) {
    return [];
  }
  const owners = await db
    .select({ id: workflows.id, organizationId: workflows.organizationId })
    .from(workflows)
    .where(
      inArray(
        workflows.id,
        claimed.map((row) => row.workflowId)
      )
    );
  const orgOf = new Map(owners.map((row) => [row.id, row.organizationId]));
  const { kept, dropped } = splitByRollout(claimed, (row) =>
    orgOf.get(row.workflowId)
  );
  if (dropped.length > 0) {
    await db.execute(sql`
      DELETE FROM ${workflowFailureAlertQueue}
      WHERE workflow_id IN (${idList(dropped.map((row) => row.workflowId))})
        AND due_at = ${lease}::timestamp
    `);
  }
  return kept;
}

/** Hand back claimed rows the budget did not reach, due now. */
async function handBack(rows: Claimed[], lease: string): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await db.execute(sql`
    UPDATE ${workflowFailureAlertQueue} SET due_at = now()
    WHERE workflow_id IN (${idList(rows.map((row) => row.workflowId))})
      AND due_at = ${lease}::timestamp
  `);
}

/** While the rollout is off nothing is evaluated: the trigger still queues every run, so clear it. */
export async function clearQueueWhileOff(): Promise<void> {
  await db.execute(sql`
    DELETE FROM ${workflowFailureAlertQueue}
    WHERE workflow_id IN (
      SELECT workflow_id FROM ${workflowFailureAlertQueue}
      WHERE due_at <= now()
      LIMIT 5000
      FOR UPDATE SKIP LOCKED
    )
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
      orgDeactivatedAt: organization.deactivatedAt,
      orgHaltedAt: organization.haltedAt,
    })
    .from(workflows)
    .leftJoin(organization, eq(organization.id, workflows.organizationId))
    .where(eq(workflows.id, workflowId))
    .limit(1);
  return row ?? null;
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

/** A halted org is not inactive: its incidents stay open but quiet, so lifting the halt does not re-alert. */
export function inactiveResolution(
  workflow: Pick<
    WorkflowRow,
    "deletedAt" | "deactivatedAt" | "enabled" | "orgDeactivatedAt"
  >,
  trigger: string | null
): FailureIncidentResolution | null {
  if (workflow.deletedAt) {
    return "deleted";
  }
  if (
    workflow.deactivatedAt ||
    !workflow.enabled ||
    workflow.orgDeactivatedAt
  ) {
    return "disabled";
  }
  if (!runsOnItsOwn(trigger)) {
    return "manual_trigger";
  }
  return null;
}

/** Reopen the incident a recent success (or, for a refused one, an accepted run) closed, unless its recovery went out. */
async function reopenRecovered(
  workflowId: string,
  failedAt: Date,
  now: Date,
  closedBy: "success" | "ran" = "success"
): Promise<IncidentRow | null> {
  const refused = closedBy === "ran";
  const [last] = await db
    .select()
    .from(workflowFailureIncidents)
    .where(
      and(
        eq(workflowFailureIncidents.workflowId, workflowId),
        isNotNull(workflowFailureIncidents.resolvedAt)
      )
    )
    .orderBy(desc(workflowFailureIncidents.resolvedAt))
    .limit(1);
  if (
    !last?.resolvedAt ||
    last.resolvedReason !== closedBy ||
    (last.openedBy === "refused") !== refused ||
    failedAt.getTime() >= last.resolvedAt.getTime() + RECOVERY_HOLD_MS
  ) {
    return null;
  }
  // Only a refusal after the run that closed it reopens it.
  if (refused && last.resolvingExecutionId) {
    const [ran] = await db
      .select({ startedAt: workflowExecutions.startedAt })
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, last.resolvingExecutionId))
      .limit(1);
    if (ran && failedAt <= ran.startedAt) {
      return null;
    }
  }
  return await db.transaction(async (tx: Tx) => {
    const recovery = and(
      eq(failureAlertDeliveries.incidentId, last.id),
      eq(failureAlertDeliveries.kind, "recovery")
    );
    const held = await tx
      .select({
        state: failureAlertDeliveries.state,
        attempts: failureAlertDeliveries.attempts,
      })
      .from(failureAlertDeliveries)
      .where(recovery)
      .for("update");
    if (
      held.some(
        (row) =>
          row.attempts > 0 ||
          !(row.state === "pending" || row.state === "skipped")
      )
    ) {
      return null;
    }
    await tx
      .update(failureAlertDeliveries)
      .set({
        state: "skipped",
        lastError: SKIP_REASON.failedAgain,
        updatedAt: now,
      })
      .where(and(recovery, eq(failureAlertDeliveries.state, "pending")));
    const [row] = await tx
      .update(workflowFailureIncidents)
      .set({
        resolvedAt: null,
        resolvedReason: null,
        resolvingExecutionId: null,
      })
      .where(
        and(
          eq(workflowFailureIncidents.id, last.id),
          isNotNull(workflowFailureIncidents.resolvedAt)
        )
      )
      .returning();
    if (row) {
      await reviveWithdrawn(tx, row, now, closedBy);
    }
    return row ?? null;
  });
}

/** Alerts and reminders the success withdrew before delivery are owed again: due now, or when an org pause ends. */
async function reviveWithdrawn(
  tx: Tx,
  incident: IncidentRow,
  now: Date,
  closedBy: "success" | "ran"
): Promise<void> {
  const [settings] = await tx
    .select({ pausedUntil: orgFailureAlertSettings.pausedUntil })
    .from(orgFailureAlertSettings)
    .where(eq(orgFailureAlertSettings.organizationId, incident.organizationId));
  const due = activePause(settings?.pausedUntil ?? null, now) ?? now;
  const withdrawn = await tx
    .select({
      id: failureAlertDeliveries.id,
      channel: failureAlertDeliveries.channel,
      attempts: failureAlertDeliveries.attempts,
      backupAt: failureAlertDeliveries.backupAt,
    })
    .from(failureAlertDeliveries)
    .where(
      and(
        eq(failureAlertDeliveries.incidentId, incident.id),
        inArray(failureAlertDeliveries.kind, ["alert", "reminder"]),
        eq(failureAlertDeliveries.isBackup, false),
        eq(failureAlertDeliveries.state, "skipped"),
        eq(failureAlertDeliveries.lastError, SKIP_REASON[closedBy])
      )
    );
  for (const row of withdrawn) {
    await tx
      .update(failureAlertDeliveries)
      .set({
        state: row.attempts > 0 ? "retrying" : "pending",
        nextAttemptAt: due,
        // backupAt also marks when it first became due (see dueSince).
        backupAt: row.backupAt
          ? new Date(due.getTime() + BACKUP_AFTER_MS[row.channel])
          : null,
        // Its backups are queued again if it is still undelivered at backupAt.
        backupSentAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(failureAlertDeliveries.id, row.id));
  }
  // Withdrawn backups stay withdrawn; renamed so they do not block the new ones.
  const renamed = await tx
    .update(failureAlertDeliveries)
    .set({
      dedupKey: sql`${failureAlertDeliveries.dedupKey} || '|withdrawn:' || ${failureAlertDeliveries.id}`,
    })
    .where(
      and(
        eq(failureAlertDeliveries.incidentId, incident.id),
        eq(failureAlertDeliveries.isBackup, true),
        eq(failureAlertDeliveries.state, "skipped"),
        eq(failureAlertDeliveries.lastError, SKIP_REASON[closedBy]),
        sql`${failureAlertDeliveries.dedupKey} NOT LIKE '%|withdrawn:%'`
      )
    )
    .returning({
      kind: failureAlertDeliveries.kind,
      sequence: failureAlertDeliveries.sequence,
    });
  // A failed or capped primary whose backup was withdrawn reached nobody: owe it a fresh backup.
  for (const backup of new Map(
    renamed.map((row) => [`${row.kind}|${row.sequence}`, row])
  ).values()) {
    await tx
      .update(failureAlertDeliveries)
      // nextAttemptAt holds a never-sent one until an org pause ends, as fireBackups reads it.
      .set({
        backupSentAt: null,
        backupAt: due,
        nextAttemptAt: due,
        updatedAt: now,
      })
      .where(
        and(
          eq(failureAlertDeliveries.incidentId, incident.id),
          eq(failureAlertDeliveries.isBackup, false),
          eq(failureAlertDeliveries.kind, backup.kind),
          eq(failureAlertDeliveries.sequence, backup.sequence),
          inArray(failureAlertDeliveries.kind, ["alert", "reminder"]),
          inArray(failureAlertDeliveries.state, ["failed", "capped"])
        )
      );
  }
}

/** The newest run since `since`: "started" skips unclaimed rows, "accepted" also platform failures. */
async function latestRunSince(
  workflowId: string,
  since: Date,
  kind: "started" | "accepted"
): Promise<{
  id: string;
  status: string;
  errorType: string | null;
  startedAt: Date;
} | null> {
  const [run] = await db
    .select({
      id: workflowExecutions.id,
      status: workflowExecutions.status,
      errorType: workflowExecutions.errorType,
      startedAt: workflowExecutions.startedAt,
    })
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.workflowId, workflowId),
        gt(workflowExecutions.startedAt, since),
        kind === "accepted"
          ? acceptedRunSql(workflowExecutions)
          : STARTED_RUN_SQL
      )
    )
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(1);
  return run ?? null;
}

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
        lastError: SKIP_REASON[reason],
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
    // A reopened incident recovers again: a new sequence, so its rows are not deduped away.
    const [prev] = await tx
      .select({
        next: sql<number>`coalesce(max(${failureAlertDeliveries.sequence}) + 1, 0)::int`,
      })
      .from(failureAlertDeliveries)
      .where(
        and(
          eq(failureAlertDeliveries.incidentId, incident.id),
          eq(failureAlertDeliveries.kind, "recovery")
        )
      );
    // A success (or a refused incident's accepted run) is announced only after the hold; a failure (refusal) in it reopens.
    const held =
      reason === "success" ||
      (reason === "ran" && incident.openedBy === "refused");
    const sendAt = held ? new Date(now.getTime() + RECOVERY_HOLD_MS) : now;
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
      const due = Math.max(
        sendAt.getTime(),
        inFlight ? now.getTime() + PAGERDUTY_IN_FLIGHT_MS : 0
      );
      rows.push({
        scope: incidentScope(incident.id),
        organizationId: incident.organizationId,
        incidentId: incident.id,
        kind: "recovery",
        sequence: prev?.next ?? 0,
        channel: row.channel,
        channelId: row.channelId,
        recipient: row.recipient,
        context: params.recoveryContext,
        nextAttemptAt: new Date(due),
        // Not a backup trigger (recoveries have none): dueSince reads the hold from it.
        backupAt: new Date(due + BACKUP_AFTER_MS[row.channel]),
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

/** What a recovery says about the run that ended a not-running incident. */
function ranContext(run: {
  startedAt: Date;
  status: string;
  errorType: string | null;
}): Record<string, unknown> {
  return {
    ranAt: run.startedAt.toISOString(),
    // A KeeperHub-side error is ours: the customer hears it started again.
    ...(run.status === "error" && run.errorType !== ExecutionErrorType.SYSTEM
      ? { ranButFailed: true }
      : {}),
  };
}

/** An open refused incident takes the newest refusal, then ends with a run accepted after it (true: evaluate again). */
async function followRefused(
  incident: IncidentRow,
  notifyRecovery: boolean,
  now: Date,
  stats: EvaluationStats
): Promise<boolean> {
  // An hourly row moves its refusal time forward: read it before trusting a later run.
  const newest = await loadNewestRefusal(
    incident.workflowId,
    incident.lastFailedAt
  );
  let current = incident;
  if (newest && newest.refusedAt > incident.lastFailedAt) {
    current = { ...incident, ...refusalFields(newest) };
    await db
      .update(workflowFailureIncidents)
      .set(refusalFields(newest))
      .where(
        and(
          eq(workflowFailureIncidents.id, incident.id),
          isNull(workflowFailureIncidents.resolvedAt)
        )
      );
  }
  // Refused runs end only with a run that was really accepted.
  const accepted = await latestRunSince(
    incident.workflowId,
    current.lastFailedAt,
    "accepted"
  );
  if (!accepted) {
    return false;
  }
  await closeIncident({
    incident: current,
    reason: "ran",
    resolvingExecutionId: accepted.id,
    notifyRecovery,
    now,
    stats,
    recoveryContext: ranContext(accepted),
  });
  return true;
}

/** The newest refusal, as a refused incident stores it (isRefusedIncident); refused at = its newest refusal. */
function refusalFields(newest: RefusedRun): {
  lastFailedAt: Date;
  lastFailedExecutionId: string;
  lastError: string;
} {
  return {
    lastFailedAt: newest.refusedAt,
    lastFailedExecutionId: newest.id,
    lastError: newest.error ?? "",
  };
}

/** Its newest attempts were all refused: a "refused" incident, held by pause and mute; it never turns the workflow off. */
async function openIfRefused(
  workflow: WorkflowRow,
  policy: EffectivePolicy,
  now: Date,
  opened: OpenedIncident[],
  stats: EvaluationStats
): Promise<Date | null> {
  const [newest] =
    (await loadRefusalStreak(workflow.id, 1, policy.countingSince)) ?? [];
  if (!newest) {
    return null;
  }
  const orgPause = activePause(policy.orgPausedUntil, now);
  if (orgPause) {
    return orgPause;
  }
  if (isMuted(policy, now)) {
    return policy.mutedUntil;
  }
  // One refusal after the accepted run, inside the recovery hold: the incident it closed continues.
  const reopened = await reopenRecovered(
    workflow.id,
    newest.refusedAt,
    now,
    "ran"
  );
  if (reopened) {
    await db
      .update(workflowFailureIncidents)
      .set(refusalFields(newest))
      .where(eq(workflowFailureIncidents.id, reopened.id));
    return null;
  }
  const first = (
    await loadRefusalStreak(
      workflow.id,
      REFUSED_RUNS_THRESHOLD,
      policy.countingSince
    )
  )?.at(-1);
  if (!first) {
    return null;
  }
  const [row] = await db
    .insert(workflowFailureIncidents)
    .values({
      organizationId: workflow.organizationId,
      workflowId: workflow.id,
      openedBy: "refused",
      threshold: policy.threshold,
      failureCount: 0,
      firstFailedAt: first.startedAt,
      ...refusalFields(newest),
      lastNotifiedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: workflowFailureIncidents.id });
  if (row) {
    stats.incidentsOpened += 1;
    opened.push({
      id: row.id,
      organizationId: workflow.organizationId,
      workflowId: workflow.id,
      refused: true,
    });
  }
  return null;
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

  let open = await loadOpenIncident(workflowId);
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
  if (workflow.orgHaltedAt) {
    return null;
  }

  // Once per org per cycle: on rollout day thousands of runs share a few orgs.
  const cycle = cycleState(stats);
  if (!cycle.orgsSeen.has(workflow.organizationId)) {
    cycle.orgsSeen.add(workflow.organizationId);
    await ensureOrgSettings(workflow.organizationId, now);
    // A failed notice is retried next cycle and must not hold up this evaluation.
    await queueLaunchNotice(workflow.organizationId, now, stats).catch(
      (error: unknown) => {
        logSystemError(
          ErrorCategory.WORKFLOW_ENGINE,
          "[FailureAlerts] Could not queue the launch notice",
          error,
          { organization_id: workflow.organizationId }
        );
      }
    );
  }

  const policy = await loadEffectivePolicy(workflow.organizationId, workflowId);
  const orgPause = activePause(policy.orgPausedUntil, now);
  const window = Math.max(
    MIN_STREAK_WINDOW,
    policy.threshold * STREAK_WINDOW_MULTIPLIER
  );
  const runs = await loadStreakRuns(workflowId, window);
  const summary = summarizeStreak(runs, policy.countingSince, window);

  // A late schedule's incident ends with any run that started; failures then count as usual.
  if (open?.openedBy === "missed") {
    const ranAgain = await latestRunSince(
      workflowId,
      open.firstFailedAt,
      "started"
    );
    if (ranAgain) {
      await closeIncident({
        incident: open,
        reason: "ran",
        resolvingExecutionId: ranAgain.id,
        notifyRecovery: policy.notifyRecovery,
        now,
        stats,
        recoveryContext: ranContext(ranAgain),
      });
      // Now closed: the run that ended it may itself start a failing streak.
      return await evaluateWorkflow(workflowId, now, opened, stats);
    }
    return null;
  }

  if (open?.openedBy === "refused") {
    if (
      await followRefused(open, policy.notifyRecovery && !orgPause, now, stats)
    ) {
      return await evaluateWorkflow(workflowId, now, opened, stats);
    }
    return null;
  }

  // A failure inside the recovery hold continues that incident: no new alert or page.
  if (!open && summary.firstFailedAt) {
    open = await reopenRecovered(workflowId, summary.firstFailedAt, now);
  }

  // It works again: the mute ends, and everyone hears what it hid.
  if (policy.muteUntilSuccess && summary.latestSuccessRunId) {
    await endMuteBecauseItWorks(workflowId, summary.latestSuccessRunId, now);
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

  // Pause box ticked after the alert, re-enabled and still failing, or out of
  // funds after a time-rule alert (runs since the last pause count).
  if (open && policy.pauseWorkflow) {
    const since = open.workflowPausedAt;
    const streak = since ? summarizeStreak(runs, since, window) : summary;
    const outOfFunds = streak.outOfFunds >= OUT_OF_FUNDS_THRESHOLD;
    if (streak.failures >= policy.threshold || outOfFunds) {
      stats.messagesQueued += await pauseOpenIncident({
        workflow,
        incident: open,
        policy,
        failures: streak.failures,
        again: since !== null,
        outOfFunds,
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

  // Refused runs, where the missed-run scan does not look: not on a schedule.
  const refusedRecheck =
    open ||
    decision.kind === "open" ||
    workflowTriggerType(workflow.nodes) === WorkflowTriggerEnum.SCHEDULE
      ? null
      : await openIfRefused(workflow, policy, now, opened, stats);
  if (decision.kind === "recheck") {
    return refusedRecheck && refusedRecheck < decision.at
      ? refusedRecheck
      : decision.at;
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
    return refusedRecheck;
  }
  // Only the count and out-of-funds rules turn a workflow off; the time rule only tells.
  const pauses = policy.pauseWorkflow && decision.by !== "time";
  // An org pause holds alerts but still turns the workflow off (it may spend gas).
  if (orgPause && !pauses) {
    return orgPause;
  }
  // A mute never hides a pause: turning a workflow off silently is worse.
  if (isMuted(policy, now) && !pauses) {
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
        openingExecutionId: summary.lastFailedRunId,
        lastError: summary.lastError,
        lastNotifiedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: workflowFailureIncidents.id });
    if (!row) {
      return null;
    }
    const paused =
      pauses && (await turnOffForIncident(tx, workflowId, row.id, now));
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
  organizationId: string,
  rows: DeliveryInsert[],
  incidentIds: string[],
  now: Date
): Promise<number> {
  return await db.transaction(async (tx: Tx) => {
    // The pause may have changed since it was read: held rows follow its end as it is now.
    await lockOrgSettings(tx, organizationId);
    const [settings] = await tx
      .select({ pausedUntil: orgFailureAlertSettings.pausedUntil })
      .from(orgFailureAlertSettings)
      .where(eq(orgFailureAlertSettings.organizationId, organizationId));
    const holdEnd = (
      activePause(settings?.pausedUntil ?? null, now) ?? now
    ).getTime();
    for (const row of rows) {
      const due = row.nextAttemptAt?.getTime() ?? now.getTime();
      const shift = due > now.getTime() ? holdEnd - due : 0;
      if (shift !== 0 && row.nextAttemptAt) {
        row.nextAttemptAt = new Date(due + shift);
        row.backupAt = row.backupAt
          ? new Date(row.backupAt.getTime() + shift)
          : row.backupAt;
      }
    }
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
      // Only org-following failures group; held alerts (org pause) go out later.
      const groupable = incidents.filter(
        (i) => !(policies.get(i.id)?.customRouting || i.holdUntil || i.refused)
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
        organizationId,
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
      openedBy: workflowFailureIncidents.openedBy,
      lastFailedExecutionId: workflowFailureIncidents.lastFailedExecutionId,
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
      id: incident.id,
      organizationId: incident.organizationId,
      workflowId: incident.workflowId,
      holdUntil: pauses.get(incident.organizationId) ?? undefined,
      refused: isRefusedIncident(incident),
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
      orgDeactivatedAt: organization.deactivatedAt,
      orgHaltedAt: organization.haltedAt,
    })
    .from(workflowFailureIncidents)
    .innerJoin(workflows, eq(workflows.id, workflowFailureIncidents.workflowId))
    .leftJoin(organization, eq(organization.id, workflows.organizationId))
    .where(
      and(
        isNull(workflowFailureIncidents.resolvedAt),
        // Filter in SQL so a wide outage cannot crowd them out; heldByPause stays open.
        sql`((${workflows.enabled} = false AND NOT ${HELD_SQL})
          OR ${workflows.deletedAt} IS NOT NULL
          OR ${workflows.deactivatedAt} IS NOT NULL
          OR (${organization.deactivatedAt} IS NOT NULL AND NOT ${HELD_SQL})
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
      orgDeactivatedAt: row.orgDeactivatedAt,
      orgHaltedAt: row.orgHaltedAt,
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

/** A refused incident stops reminding once nothing has been refused for REFUSALS_STOPPED_MS. */
function refusalsStopped(incident: IncidentRow, now: Date): boolean {
  return (
    incident.openedBy === "refused" &&
    now.getTime() - incident.lastFailedAt.getTime() >= REFUSALS_STOPPED_MS
  );
}

/** Daily reminders; compare-and-set on the count so only one evaluator sends. */
export async function queueReminders(
  now: Date,
  stats: EvaluationStats
): Promise<void> {
  const due = await openIncidentsNotifiedBy(
    new Date(now.getTime() - REMINDER_INTERVAL_MS)
  );
  const owed = await owedByOrg(due, now, true);

  // An org with an org-rule reminder due takes its other org-rule reminders due within half a
  // day along, but only when that makes a shared message; nothing goes out early on its own.
  const groupingOrgs = [...owed]
    .filter(([, list]) => list.some(canGroup))
    .map(([organizationId]) => organizationId);
  // Only rows not yet due, so the due ones do not use up the limit.
  const early = await openIncidentsNotifiedBy(
    new Date(now.getTime() - REMINDER_INTERVAL_MS + DIGEST_PULL_IN_MS),
    groupingOrgs,
    new Date(now.getTime() - REMINDER_INTERVAL_MS)
  );
  const earlyOwed = await owedByOrg(early, now, false);

  for (const [organizationId, list] of owed) {
    let members: OrgMember[];
    try {
      members = await loadOrgMembers(organizationId);
    } catch (error) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[FailureAlerts] Could not queue reminders",
        error,
        { organization_id: organizationId }
      );
      continue;
    }
    const groupable = [
      ...list.filter(canGroup),
      ...(earlyOwed.get(organizationId) ?? []).filter(canGroup),
    ];
    let grouped = groupable.length >= GROUP_ALERTS_FROM ? groupable : [];
    if (grouped.length > 0) {
      try {
        if (
          !(await queueGroupedReminder(
            organizationId,
            grouped,
            members,
            now,
            stats
          ))
        ) {
          // Another worker took most of the group: the due ones go out one by one.
          grouped = [];
        }
      } catch (error) {
        grouped = [];
        logSystemError(
          ErrorCategory.WORKFLOW_ENGINE,
          "[FailureAlerts] Could not queue a grouped reminder",
          error,
          { organization_id: organizationId }
        );
      }
    }
    const groupedIds = new Set(grouped.map((g) => g.incident.id));
    for (const { incident, policy } of list) {
      if (groupedIds.has(incident.id)) {
        continue;
      }
      try {
        await queueOneReminder(incident, policy, members, now, stats);
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
}

/** Org-rule workflows still failing can share a message; their own rules or refusals cannot. */
function canGroup({ incident, policy }: OwedReminder): boolean {
  return !(policy.customRouting || isRefusedIncident(incident));
}

type OwedReminder = {
  incident: typeof workflowFailureIncidents.$inferSelect;
  policy: EffectivePolicy;
};

/** Open incidents last notified at or before `before` (and after `after`, when given), oldest first. */
async function openIncidentsNotifiedBy(
  before: Date,
  orgIds?: string[],
  after?: Date
) {
  if (orgIds?.length === 0) {
    return [];
  }
  return await db
    .select({
      incident: workflowFailureIncidents,
      enabled: workflows.enabled,
      deletedAt: workflows.deletedAt,
      deactivatedAt: workflows.deactivatedAt,
      nodes: workflows.nodes,
      orgDeactivatedAt: organization.deactivatedAt,
      orgHaltedAt: organization.haltedAt,
    })
    .from(workflowFailureIncidents)
    .innerJoin(workflows, eq(workflows.id, workflowFailureIncidents.workflowId))
    .leftJoin(organization, eq(organization.id, workflows.organizationId))
    .where(
      and(
        isNull(workflowFailureIncidents.resolvedAt),
        isNotNull(workflowFailureIncidents.alertQueuedAt),
        lte(workflowFailureIncidents.lastNotifiedAt, before),
        after ? gt(workflowFailureIncidents.lastNotifiedAt, after) : undefined,
        lt(workflowFailureIncidents.reminderCount, MAX_REMINDERS),
        orgIds
          ? inArray(workflowFailureIncidents.organizationId, orgIds)
          : undefined
      )
    )
    .orderBy(workflowFailureIncidents.lastNotifiedAt)
    .limit(100);
}

/**
 * The reminders owed now, by org: a workflow its incident paused, or one that cannot run, is not
 * "still failing". With `settle`, one not owed has its clock moved so it stops crowding the due list.
 */
async function owedByOrg(
  rows: Awaited<ReturnType<typeof openIncidentsNotifiedBy>>,
  now: Date,
  settle: boolean
): Promise<Map<string, OwedReminder[]>> {
  const owed = new Map<string, OwedReminder[]>();
  for (const { incident, ...workflow } of rows) {
    try {
      const policy = isFailureAlertsEnabledForOrg(incident.organizationId)
        ? await loadEffectivePolicy(
            incident.organizationId,
            incident.workflowId
          )
        : null;
      if (
        !policy?.remindDaily ||
        isMuted(policy, now) ||
        isHeld(incident) ||
        workflow.orgHaltedAt ||
        inactiveResolution(workflow, workflowTriggerType(workflow.nodes)) ||
        activePause(policy.orgPausedUntil, now) ||
        refusalsStopped(incident, now)
      ) {
        if (settle) {
          await db
            .update(workflowFailureIncidents)
            .set({ lastNotifiedAt: now })
            .where(eq(workflowFailureIncidents.id, incident.id));
        }
        continue;
      }
      const list = owed.get(incident.organizationId) ?? [];
      list.push({ incident, policy });
      owed.set(incident.organizationId, list);
    } catch (error) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[FailureAlerts] Could not queue a reminder",
        error,
        { incident_id: incident.id }
      );
    }
  }
  return owed;
}

/** Claims one reminder (compare-and-set on its count) inside `tx`; false if another worker took it. */
async function claimReminder(
  tx: Tx,
  incident: typeof workflowFailureIncidents.$inferSelect,
  now: Date
): Promise<boolean> {
  const claimed = await tx
    .update(workflowFailureIncidents)
    .set({ reminderCount: incident.reminderCount + 1, lastNotifiedAt: now })
    .where(
      and(
        eq(workflowFailureIncidents.id, incident.id),
        eq(workflowFailureIncidents.reminderCount, incident.reminderCount),
        // Closed since it was read: no "still failing" after its recovery.
        isNull(workflowFailureIncidents.resolvedAt)
      )
    )
    .returning({ id: workflowFailureIncidents.id });
  return claimed.length > 0;
}

async function queueOneReminder(
  incident: typeof workflowFailureIncidents.$inferSelect,
  policy: EffectivePolicy,
  members: OrgMember[],
  now: Date,
  stats: EvaluationStats
): Promise<void> {
  const sequence = incident.reminderCount + 1;
  // Claim and rows together, so a failed insert never uses up a reminder.
  const queued = await db.transaction(async (tx: Tx) => {
    if (!(await claimReminder(tx, incident, now))) {
      return null;
    }
    return await insertDeliveries(
      rowsForPolicy(
        policy,
        members,
        incident.organizationId,
        incident.id,
        "reminder",
        sequence,
        now
      ),
      tx
    );
  });
  if (queued !== null) {
    stats.messagesQueued += queued;
    stats.remindersQueued += 1;
  }
}

/**
 * One daily reminder listing every org-rule workflow still failing; PagerDuty gets none, as before.
 * False, with nothing claimed, when fewer than GROUP_ALERTS_FROM could be claimed.
 */
async function queueGroupedReminder(
  organizationId: string,
  owed: OwedReminder[],
  members: OrgMember[],
  now: Date,
  stats: EvaluationStats
): Promise<boolean> {
  const org = await loadOrgPolicy(organizationId);
  const channels = await loadChannels(organizationId, null);
  // One lock order for every worker, so two cycles never deadlock on the same group.
  const ordered = [...owed].sort((a, b) =>
    a.incident.id.localeCompare(b.incident.id)
  );
  try {
    await db.transaction(async (tx: Tx) => {
      const claimed: OwedReminder[] = [];
      for (const owedOne of ordered) {
        if (await claimReminder(tx, owedOne.incident, now)) {
          claimed.push(owedOne);
        }
      }
      const [first] = claimed;
      if (!first || claimed.length < GROUP_ALERTS_FROM) {
        // Gives every claim back, early ones included.
        throw new TooFewToGroup();
      }
      stats.messagesQueued += await insertDeliveries(
        buildMessageRows({
          scope: groupScope(first.incident.id),
          organizationId,
          incidentId: null,
          kind: "reminder",
          // Unique per day: the first incident's new count.
          sequence: first.incident.reminderCount + 1,
          emails: resolveRecipientEmails(org.recipientUserIds, members),
          channels,
          includePagerDuty: false,
          context: { incidentIds: claimed.map((c) => c.incident.id) },
          now,
        }),
        tx
      );
      stats.remindersQueued += claimed.length;
    });
  } catch (error) {
    if (error instanceof TooFewToGroup) {
      return false;
    }
    throw error;
  }
  return true;
}

class TooFewToGroup extends Error {}

/** One-time launch notice of already-failing workflows; claim and rows commit together. */
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
  const [settings] = await db
    .select({ sentAt: orgFailureAlertSettings.launchNoticeSentAt })
    .from(orgFailureAlertSettings)
    .where(eq(orgFailureAlertSettings.organizationId, organizationId));
  if (!settings || settings.sentAt) {
    return;
  }
  cycle.launchScans += 1;
  // Read outside the transaction, so the settings row is not locked during the scan.
  const rows = await launchNoticeRows(organizationId, now);
  stats.messagesQueued += await db.transaction(async (tx: Tx) => {
    const claimed = await tx
      .update(orgFailureAlertSettings)
      .set({ launchNoticeSentAt: now })
      .where(
        and(
          eq(orgFailureAlertSettings.organizationId, organizationId),
          isNull(orgFailureAlertSettings.launchNoticeSentAt)
        )
      )
      .returning({ organizationId: orgFailureAlertSettings.organizationId });
    return claimed.length === 0 ? 0 : await insertDeliveries(rows, tx);
  });
}

async function launchNoticeRows(
  organizationId: string,
  now: Date
): Promise<DeliveryInsert[]> {
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
    return [];
  }

  const failingNow = await findFailingWorkflows(organizationId);
  const owners = resolveRecipientEmails(
    null,
    await loadOrgMembers(organizationId)
  );
  return owners.map((email) => ({
    scope: `launch:${organizationId}`,
    organizationId,
    incidentId: null,
    kind: "launch_notice" as const,
    sequence: 0,
    channel: "email" as const,
    recipient: email,
    nextAttemptAt: now,
    context: { failingNow },
  }));
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
    const runs = await loadStreakRuns(
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

/** Where the missed-run scan stopped; per pod, so a restart or another pod only rescans from the top. */
let missedScanCursor: string | null = null;
/** A scheduler outage is ours: customers hear only once it lasts this long. */
const PLATFORM_HOLD_MS = 30 * 60 * 1000;
type Refusal = {
  id: string;
  error: string | null;
  /** Its newest refusal (an hourly row's completedAt). */
  refusedAt: Date;
};

/** Each workflow's newest refused run since `since`. */
async function latestRefusals(
  workflowIds: string[],
  since: Date
): Promise<Map<string, Refusal>> {
  if (workflowIds.length === 0) {
    return new Map();
  }
  const refusedAt = sql`coalesce(${workflowExecutions.completedAt}, ${workflowExecutions.startedAt})`;
  const rows = await db
    .selectDistinctOn([workflowExecutions.workflowId], {
      workflowId: workflowExecutions.workflowId,
      id: workflowExecutions.id,
      error: workflowExecutions.error,
      refusedAt: refusedAt.mapWith(workflowExecutions.startedAt),
    })
    .from(workflowExecutions)
    .where(
      and(
        inArray(workflowExecutions.workflowId, workflowIds),
        sql`${refusedAt} >= ${sql.param(since, workflowExecutions.startedAt)}`,
        // Index bound: a row's newest refusal is under an hour after its start.
        gte(workflowExecutions.startedAt, beforeBucket(since)),
        isNull(workflowExecutions.deletedAt),
        REFUSED_RUN_SQL
      )
    )
    .orderBy(workflowExecutions.workflowId, desc(refusedAt));
  return new Map(rows.map((row) => [row.workflowId, row]));
}

/** Refused recently, at or after the run it missed and after its last real run: not our scheduler. */
function refusalFor(
  refusals: Map<string, Refusal>,
  row: { workflowId: string; lastStartedAt: Date | null },
  dueAt: Date,
  now: Date
): Refusal | null {
  const refusal = refusals.get(row.workflowId);
  if (
    !refusal ||
    refusal.refusedAt.getTime() < dueAt.getTime() - REFUSAL_RECENT_MS ||
    refusal.refusedAt.getTime() < now.getTime() - REFUSAL_RECENT_MS ||
    (row.lastStartedAt && refusal.refusedAt <= row.lastStartedAt)
  ) {
    return null;
  }
  return refusal;
}

/** Open "not running" incidents take the newest refusal as their reason (a plain one becomes refused). */
async function refreshMissedRefusals(now: Date): Promise<void> {
  const open = await db
    .select({
      id: workflowFailureIncidents.id,
      workflowId: workflowFailureIncidents.workflowId,
      firstFailedAt: workflowFailureIncidents.firstFailedAt,
      lastFailedExecutionId: workflowFailureIncidents.lastFailedExecutionId,
    })
    .from(workflowFailureIncidents)
    .where(
      and(
        isNull(workflowFailureIncidents.resolvedAt),
        eq(workflowFailureIncidents.openedBy, "missed")
      )
    )
    .limit(MISSED_SCAN_LIMIT);
  const refusals = await latestRefusals(
    open.map((row) => row.workflowId),
    new Date(now.getTime() - REFUSAL_RECENT_MS)
  );
  for (const incident of open) {
    const refusal = refusalFor(
      refusals,
      { workflowId: incident.workflowId, lastStartedAt: null },
      incident.firstFailedAt,
      now
    );
    if (!refusal || refusal.id === incident.lastFailedExecutionId) {
      continue;
    }
    await db
      .update(workflowFailureIncidents)
      .set({
        lastFailedExecutionId: refusal.id,
        lastError: refusal.error ?? "",
      })
      .where(
        and(
          eq(workflowFailureIncidents.id, incident.id),
          isNull(workflowFailureIncidents.resolvedAt)
        )
      );
  }
}

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
      // Moved on create, re-enable, a cron/interval/timezone change, each run and org resume: no miss counts before it.
      scheduleSince:
        sql`greatest(${workflowSchedules.createdAt}, ${workflowSchedules.updatedAt})`.mapWith(
          workflowSchedules.updatedAt
        ),
      lastStartedAt: sql`(SELECT max(${workflowExecutions.startedAt})
        FROM ${workflowExecutions}
        WHERE ${workflowExecutions.workflowId} = ${workflows.id}
          AND ${STARTED_RUN_SQL})`.mapWith(workflowExecutions.startedAt),
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
            AND ${STARTED_RUN_SQL})`,
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
  const dueAnywhere = candidates.flatMap((row) => {
    const dueAt =
      workflowTriggerType(row.nodes) === "Schedule"
        ? missedDueAt({
            schedule: row,
            lastStartedAt: row.lastStartedAt,
            notBefore: row.scheduleSince,
            now,
          })
        : null;
    return dueAt ? [{ ...row, dueAt }] : [];
  });
  const earliestDue = Math.min(
    ...dueAnywhere.map((row) => row.dueAt.getTime())
  );
  const refusals = await latestRefusals(
    dueAnywhere.map((row) => row.workflowId),
    new Date(earliestDue - REFUSAL_RECENT_MS)
  );
  // Refused runs (a plan limit, unpaid) are not a scheduler outage.
  const lateAnywhere = dueAnywhere.filter(
    (row) => !refusalFor(refusals, row, row.dueAt, now)
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
  const late: ((typeof candidates)[number] & {
    dueAt: Date;
    refusal: Refusal | null;
  })[] = [];
  for (const row of dueAnywhere) {
    if (!isFailureAlertsEnabledForOrg(row.organizationId)) {
      continue;
    }
    if (!counting.has(row.organizationId)) {
      const stored = (await loadOrgPolicy(row.organizationId)).countingSince;
      if (!stored) {
        // Store the start, so later cycles measure from it rather than from their own now.
        await ensureOrgSettings(row.organizationId, now);
      }
      counting.set(row.organizationId, stored);
    }
    // A new org starts counting now, so nothing before this cycle is "late".
    const since = counting.get(row.organizationId) ?? now;
    const dueAt = missedDueAt({
      schedule: row,
      lastStartedAt: row.lastStartedAt,
      notBefore: new Date(
        Math.max(since.getTime(), row.scheduleSince.getTime())
      ),
      now,
    });
    if (dueAt) {
      late.push({
        ...row,
        dueAt,
        refusal: refusalFor(refusals, row, dueAt, now),
      });
    }
  }

  const opened: OpenedIncident[] = [];
  for (const row of late) {
    if (
      platformWide &&
      !row.refusal &&
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
          // Marks it refused (isRefusedIncident): the refusal and its stored reason.
          lastFailedExecutionId: row.refusal?.id ?? null,
          lastError: row.refusal ? (row.refusal.error ?? "") : null,
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
          refused: Boolean(row.refusal),
        });
        if (row.refusal) {
          continue;
        }
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
  await refreshMissedRefusals(now);
}

/** Drain the queue in batches until it is empty or the budget runs out, then queue the alerts. */
export async function evaluateQueuedWorkflows(
  now: Date,
  stats: EvaluationStats,
  deadline: number = Date.now() + EVALUATE_BUDGET_MS
): Promise<void> {
  const opened: OpenedIncident[] = [];
  const started = Date.now();
  const seen = new Set<string>();
  let full = true;
  while (full && Date.now() < deadline) {
    const claimed = await claimQueue(seen);
    full = claimed.length >= MAX_WORKFLOWS_PER_RUN;
    const lease = claimed[0]?.lease ?? "";
    for (const row of claimed) {
      seen.add(row.workflowId);
    }
    // Rechecks are dated from this batch's time, so they are not due again within the budget.
    const batchNow = new Date(now.getTime() + Date.now() - started);
    const live = await dropOutsideRollout(claimed, lease);
    for (const [index, { workflowId }] of live.entries()) {
      if (Date.now() >= deadline) {
        await handBack(live.slice(index), lease);
        break;
      }
      try {
        const recheckAt = await evaluateWorkflow(
          workflowId,
          batchNow,
          opened,
          stats
        );
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
  }
  await queueAlerts(opened, now, stats);
}
