import "server-only";

import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { getOrgPlan } from "@/lib/billing/plans-server";
import { db } from "@/lib/db";
import {
  failureAlertChannels,
  failureAlertDeliveries,
  failureAlertEmailUsage,
  integrations,
  organization,
  workflowExecutions,
  workflowFailureAlertOverrides,
  workflowFailureIncidents,
  workflows,
} from "@/lib/db/schema";
import type { FailureAlertDeliveryState } from "@/lib/db/schema-failure-alerts";
import type { Tx } from "@/lib/db/tx";
import { ErrorCategory, logSystemError, logSystemWarn } from "@/lib/logging";
import {
  loadOrgMembers,
  reachableEmails,
} from "@/lib/notifications/org-recipients";
import { redactErrorSecrets } from "@/lib/utils/redact";
import {
  BACKUP_AFTER_MS,
  DELIVERY_BATCH,
  FREE_PLAN_MONTHLY_EMAILS,
  HEALTH_CHECK_INTERVAL_MS,
  MAX_REMINDERS,
  PAGERDUTY_RESOLVE_STALE_MS,
  RETENTION_DAYS,
  RETRY_DELAYS_MS,
  STALE_DELIVERY_MS,
  STALE_SENDING_MS,
} from "./constants";
import {
  type AlertWorkflow,
  type MessageInput,
  type Refused,
  type RenderedMessage,
  renderMessage,
  runsUrl,
} from "./messages";
import { activePause } from "./org-pause";
import {
  type ChannelConfig,
  loadChannels,
  loadChannelsByIds,
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
} from "./queue-rows";
import { splitByRollout } from "./rollout";
import {
  checkChannelSilently,
  type DeliveryOutcome,
  sendChannelMessage,
  sendEmailMessage,
} from "./senders";
import { isReachable, loadChannelViews } from "./settings";
import { SKIP_REASON } from "./stored-reasons";
import {
  CHANNEL_LABEL,
  channelLabel,
  EMAILS_KEPT_FOR_NEW_FAILURES,
  isRefusedIncident,
} from "./view-types";
import { workflowTriggerType } from "./workflow-trigger";

type DeliveryRow = typeof failureAlertDeliveries.$inferSelect;
type IncidentRow = typeof workflowFailureIncidents.$inferSelect;

export type DrainStats = {
  delivered: number;
  retrying: number;
  failed: number;
  capped: number;
  backupsQueued: number;
  channelsStopped: number;
  healthChecks: number;
};

export function emptyDrainStats(): DrainStats {
  return {
    delivered: 0,
    retrying: 0,
    failed: 0,
    capped: 0,
    backupsQueued: 0,
    channelsStopped: 0,
    healthChecks: 0,
  };
}

/** Delay before the next attempt, honouring a provider's Retry-After. */
export function nextRetryDelayMs(
  attempts: number,
  retryAfterMs: number | undefined
): number {
  const index = Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1);
  return Math.max(RETRY_DELAYS_MS[index], retryAfterMs ?? 0);
}

/** The scope a row was queued under, so its backups and recovery share it. */
function scopeOf(row: DeliveryRow): string {
  if (row.incidentId) {
    return incidentScope(row.incidentId);
  }
  const ids = row.context?.incidentIds;
  if (Array.isArray(ids) && ids.length > 0) {
    return groupScope(String(ids[0]));
  }
  return `row:${row.id}`;
}

/** Claim due rows, taking over "sending" rows a dead evaluator left behind. */
async function claimDue(): Promise<DeliveryRow[]> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE ${failureAlertDeliveries}
    SET state = 'sending', updated_at = now()
    WHERE id IN (
      SELECT id FROM ${failureAlertDeliveries}
      WHERE (state IN ('pending', 'retrying') AND next_attempt_at <= now())
         OR (state = 'sending' AND updated_at < now() - (${STALE_SENDING_MS} * interval '1 millisecond'))
      ORDER BY next_attempt_at
      LIMIT ${DELIVERY_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);
  const ids = [...rows].map((row) => row.id);
  if (ids.length === 0) {
    return [];
  }
  return await db
    .select()
    .from(failureAlertDeliveries)
    .where(inArray(failureAlertDeliveries.id, ids));
}

/** Per-cycle cache, so a grouped alert to ten people reads each thing once. */
class Context {
  private readonly orgNames = new Map<string, string>();
  private readonly incidents = new Map<string, IncidentRow | null>();
  private readonly workflowsById = new Map<string, AlertWorkflow | null>();
  private readonly plans = new Map<string, string>();
  private readonly history = new Map<string, Promise<RunsBefore>>();
  readonly channels = new Map<string, ChannelConfig>();
  readonly appUrl: string;

  constructor(appUrl: string) {
    this.appUrl = appUrl;
  }

  async loadChannels(ids: string[]): Promise<void> {
    const missing = ids.filter((id) => !this.channels.has(id));
    for (const [id, channel] of await loadChannelsByIds(missing)) {
      this.channels.set(id, channel);
    }
  }

  async orgName(organizationId: string): Promise<string> {
    const cached = this.orgNames.get(organizationId);
    if (cached) {
      return cached;
    }
    const [row] = await db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    const name = row?.name ?? "Your organization";
    this.orgNames.set(organizationId, name);
    return name;
  }

  async plan(organizationId: string): Promise<string> {
    const cached = this.plans.get(organizationId);
    if (cached) {
      return cached;
    }
    const plan = await getOrgPlan(organizationId);
    this.plans.set(organizationId, plan);
    return plan;
  }

  async incident(id: string): Promise<IncidentRow | null> {
    if (this.incidents.has(id)) {
      return this.incidents.get(id) ?? null;
    }
    const [row] = await db
      .select()
      .from(workflowFailureIncidents)
      .where(eq(workflowFailureIncidents.id, id))
      .limit(1);
    this.incidents.set(id, row ?? null);
    return row ?? null;
  }

  async workflow(id: string): Promise<AlertWorkflow | null> {
    if (this.workflowsById.has(id)) {
      return this.workflowsById.get(id) ?? null;
    }
    const [row] = await db
      .select({
        id: workflows.id,
        name: workflows.name,
        nodes: workflows.nodes,
      })
      .from(workflows)
      .where(eq(workflows.id, id))
      .limit(1);
    const value = row
      ? {
          id: row.id,
          name: row.name,
          triggerLabel: workflowTriggerType(row.nodes) ?? "Automatic",
        }
      : null;
    this.workflowsById.set(id, value);
    return value;
  }

  /** A refused incident's newest refusal (its stored reason). */
  refused(incident: IncidentRow): Refused | undefined {
    return isRefusedIncident(incident) && incident.lastFailedExecutionId
      ? { reason: incident.lastError }
      : undefined;
  }

  /** One history query per incident, however many rows announce it. */
  runsBefore(incident: IncidentRow): Promise<RunsBefore> {
    let cached = this.history.get(incident.id);
    if (!cached) {
      cached = runsBefore(incident.workflowId, incident.firstFailedAt).catch(
        (error: unknown) => {
          // A failed read is not kept: the next row asks again.
          this.history.delete(incident.id);
          throw error;
        }
      );
      this.history.set(incident.id, cached);
    }
    return cached;
  }
}

type Rendered = {
  rendered: RenderedMessage;
  details?: Record<string, unknown>;
  link?: string;
};

/** Build what one outbox row says. Null when what it was about is gone. */
const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type RunsBefore = { successes: number; lastSuccessAt: Date | null };

/** Successful runs in the 30 days before a streak, to show how unusual it is. */
async function runsBefore(
  workflowId: string,
  firstFailedAt: Date
): Promise<RunsBefore> {
  const [row] = await db
    .select({
      successes: sql<number>`count(*)::int`,
      lastSuccessAt: sql`max(${workflowExecutions.completedAt})`.mapWith(
        workflowExecutions.completedAt
      ),
    })
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.workflowId, workflowId),
        eq(workflowExecutions.status, "success"),
        lt(workflowExecutions.startedAt, firstFailedAt),
        gte(
          workflowExecutions.startedAt,
          new Date(firstFailedAt.getTime() - HISTORY_WINDOW_MS)
        )
      )
    );
  return {
    successes: row?.successes ?? 0,
    lastSuccessAt: row?.lastSuccessAt ?? null,
  };
}

/** Whether this alert or reminder says the workflow was turned off, from what it was queued with. */
function disabledVariant(
  kind: string,
  context: Record<string, unknown>,
  incident: { workflowDisabledAt: Date | null }
): "first" | "again" | undefined {
  if (context.disabledAgain === true) {
    return "again";
  }
  if (context.workflowDisabled === true) {
    return "first";
  }
  // A re-queued alert lost its context; the incident still knows.
  return kind === "alert" && incident.workflowDisabledAt !== null
    ? "first"
    : undefined;
}

/** Open incidents as a grouped message lists them. */
async function groupedList(
  ids: string[],
  ctx: Context
): Promise<Extract<MessageInput, { kind: "grouped" }>["workflows"]> {
  const list: Extract<MessageInput, { kind: "grouped" }>["workflows"] = [];
  for (const id of ids) {
    const incident = await ctx.incident(id);
    const workflow = incident ? await ctx.workflow(incident.workflowId) : null;
    if (incident && workflow && !incident.resolvedAt) {
      list.push({
        ...workflow,
        failureCount: incident.failureCount,
        workflowDisabled: incident.workflowDisabledAt !== null,
        lastError: incident.lastError,
        openedBy: incident.openedBy,
        refused: ctx.refused(incident),
      });
    }
  }
  return list;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

/** A pause or removal notice from what was stored when it was queued. */
function pauseNoticeInput(
  kind:
    | "workflow_alerts_paused"
    | "workflow_alerts_resumed"
    | "workflow_alerts_pause_ended"
    | "recipients_removed",
  context: Record<string, unknown>,
  org: { orgName: string; organizationId: string; appUrl: string }
): MessageInput {
  const workflow = text(context.workflowId)
    ? {
        id: String(context.workflowId),
        name: text(context.workflowName) ?? "A workflow",
      }
    : null;
  const by = text(context.by);
  const byAccount = text(context.byAccount);
  if (kind === "recipients_removed") {
    return {
      ...org,
      kind,
      workflow: workflow ?? undefined,
      by,
      byAccount,
      removed: Array.isArray(context.removed)
        ? (context.removed as unknown[]).map(String)
        : [],
    };
  }
  const named = workflow ?? { id: "", name: "A workflow" };
  if (kind === "workflow_alerts_resumed") {
    return { ...org, kind, workflow: named, by, byAccount };
  }
  if (kind === "workflow_alerts_pause_ended") {
    return {
      ...org,
      kind,
      workflow: named,
      by: text(context.pausedBy),
      reason: text(context.reason),
      until: text(context.until) ? new Date(String(context.until)) : null,
      untilItWorks: context.untilItWorks === true,
      ended: context.ended === "worked" ? "worked" : "expired",
      failedRuns: Number(context.failedRuns ?? 0),
      failingNow: context.failingNow === true,
      alertsPausedUntil: text(context.alertsPausedUntil)
        ? new Date(String(context.alertsPausedUntil))
        : null,
    };
  }
  return {
    ...org,
    kind,
    workflow: named,
    by,
    byAccount,
    reason: text(context.reason),
    until: text(context.until) ? new Date(String(context.until)) : null,
    untilItWorks: context.untilItWorks === true,
    changed: context.changed === true,
  };
}

async function renderRow(
  row: DeliveryRow,
  ctx: Context
): Promise<Rendered | null> {
  const org = {
    orgName: await ctx.orgName(row.organizationId),
    organizationId: row.organizationId,
    appUrl: ctx.appUrl,
  };
  const context = row.context ?? {};
  const backupReason =
    typeof context.backupReason === "string" ? context.backupReason : undefined;
  let input: MessageInput;

  if (row.kind === "channel_stopped") {
    input = {
      ...org,
      kind: "channel_stopped",
      channelLabel: String(context.channelLabel ?? "A channel"),
      channelKind:
        typeof context.channelKind === "string"
          ? context.channelKind
          : undefined,
      reason: String(context.reason ?? ""),
      workflow:
        typeof context.workflowId === "string" &&
        typeof context.workflowName === "string"
          ? { id: context.workflowId, name: context.workflowName }
          : undefined,
    };
  } else if (row.kind === "cap_warning") {
    input = {
      ...org,
      kind: "cap_warning",
      used: Number(context.used ?? 0),
      limit: Number(context.limit ?? FREE_PLAN_MONTHLY_EMAILS),
      chatWorks: isReachable(
        [],
        await loadChannelViews(row.organizationId, null)
      ),
    };
  } else if (row.kind === "alerts_paused") {
    input = {
      ...org,
      kind: "alerts_paused",
      until: new Date(String(context.until)),
      reason: typeof context.reason === "string" ? context.reason : null,
      by: typeof context.by === "string" ? context.by : null,
      disablingWorkflows:
        typeof context.disablingWorkflows === "number"
          ? context.disablingWorkflows
          : undefined,
    };
  } else if (row.kind === "alerts_resumed") {
    input = {
      ...org,
      kind: "alerts_resumed",
      by: typeof context.by === "string" ? context.by : null,
    };
  } else if (
    row.kind === "workflow_alerts_paused" ||
    row.kind === "workflow_alerts_resumed" ||
    row.kind === "workflow_alerts_pause_ended" ||
    row.kind === "recipients_removed"
  ) {
    input = pauseNoticeInput(row.kind, context, org);
  } else if (row.kind === "launch_notice") {
    input = {
      ...org,
      kind: "launch_notice",
      threshold: (await loadOrgPolicy(row.organizationId)).threshold,
      failingNow: (context.failingNow ?? []) as (AlertWorkflow & {
        failureCount: number;
      })[],
    };
  } else if (Array.isArray(context.incidentIds)) {
    const list = await groupedList(context.incidentIds as string[], ctx);
    if (list.length === 0) {
      return null;
    }
    input = {
      ...org,
      kind: "grouped",
      workflows: list,
      backupReason,
      reminder: row.kind === "reminder",
    };
  } else {
    const incident = row.incidentId ? await ctx.incident(row.incidentId) : null;
    const workflow = incident ? await ctx.workflow(incident.workflowId) : null;
    // A "still failing" message must not land after the workflow recovered,
    // e.g. a row taken over from a crashed evaluator after the close.
    // A recovery is stale once its incident reopened.
    const stale =
      row.kind === "recovery"
        ? !incident?.resolvedAt
        : Boolean(incident?.resolvedAt);
    if (!(incident && workflow) || stale) {
      return null;
    }
    const alertIncident = {
      failureCount: incident.failureCount,
      firstFailedAt: incident.firstFailedAt,
      lastError: incident.lastError,
      // A wallet that ran dry turned it off: say so, whatever opened it.
      openedBy:
        context.outOfFunds === true ? ("funding" as const) : incident.openedBy,
      refused: ctx.refused(incident),
      before:
        row.kind === "recovery" ? undefined : await ctx.runsBefore(incident),
    };
    input =
      row.kind === "recovery"
        ? {
            ...org,
            kind: "recovery",
            workflow,
            incident: alertIncident,
            ranButFailed: context.ranButFailed === true,
            resolvedAt: incident.resolvedAt,
            ranAt:
              typeof context.ranAt === "string"
                ? new Date(context.ranAt)
                : null,
          }
        : {
            ...org,
            kind: row.kind === "reminder" ? "reminder" : "alert",
            workflow,
            incident: alertIncident,
            backupReason,
            disabled: disabledVariant(row.kind, context, incident),
            reminderNumber: row.kind === "reminder" ? row.sequence : undefined,
            maxReminders: MAX_REMINDERS,
            disabledFailures:
              typeof context.failures === "number"
                ? context.failures
                : undefined,
          };
    const link = runsUrl(ctx.appUrl, workflow.id);
    return {
      rendered: renderMessage(input),
      link,
      details: {
        organization: org.orgName,
        workflow: workflow.name,
        trigger: workflow.triggerLabel,
        failing_since: incident.firstFailedAt.toISOString(),
        failed_runs_in_a_row: incident.failureCount,
        last_error: incident.lastError
          ? redactErrorSecrets(incident.lastError)
          : null,
        runs: link,
      },
    };
  }
  return { rendered: renderMessage(input) };
}

/** Reserve one email of the Free monthly allowance; false when used up. */
async function reserveEmail(
  organizationId: string,
  ctx: Context,
  kind: string
): Promise<boolean> {
  if ((await ctx.plan(organizationId)) !== "free") {
    return true;
  }
  // The last few emails of the month are kept for new failures.
  const limit =
    kind === "alert"
      ? FREE_PLAN_MONTHLY_EMAILS
      : FREE_PLAN_MONTHLY_EMAILS - EMAILS_KEPT_FOR_NEW_FAILURES;
  const rows = await db.execute<{ sent: number }>(sql`
    INSERT INTO ${failureAlertEmailUsage} (organization_id, period_start, sent)
    VALUES (${organizationId}, date_trunc('month', now() AT TIME ZONE 'UTC'), 1)
    ON CONFLICT (organization_id, period_start) DO UPDATE
      SET sent = ${failureAlertEmailUsage}.sent + 1
      WHERE ${failureAlertEmailUsage}.sent < ${limit}
    RETURNING sent
  `);
  const sent = [...rows][0]?.sent;
  if (sent === undefined) {
    return false;
  }
  const warnAt = CAP_WARNINGS.find((at) => at === Number(sent));
  if (warnAt) {
    await queueCapWarning(organizationId, warnAt);
  }
  return true;
}

const CAP_WARNINGS = [80, FREE_PLAN_MONTHLY_EMAILS];

/** Tell the email recipients once when the Free plan's alert emails run low or out. */
async function queueCapWarning(
  organizationId: string,
  used: number
): Promise<void> {
  const now = new Date();
  const period = now.toISOString().slice(0, 7);
  const org = await loadOrgPolicy(organizationId);
  const emails = resolveRecipientEmails(
    org.recipientUserIds,
    await loadOrgMembers(organizationId)
  );
  await insertDeliveries(
    emails.map((email) => ({
      scope: `cap:${organizationId}:${period}:${used}`,
      organizationId,
      incidentId: null,
      kind: "cap_warning" as const,
      sequence: 0,
      channel: "email" as const,
      recipient: email,
      nextAttemptAt: now,
      context: { used, limit: FREE_PLAN_MONTHLY_EMAILS },
    }))
  );
}

/** Give back a reservation for an email the provider did not accept. */
async function releaseEmail(
  organizationId: string,
  ctx: Context
): Promise<void> {
  if ((await ctx.plan(organizationId)) !== "free") {
    return;
  }
  await db.execute(sql`
    UPDATE ${failureAlertEmailUsage}
    SET sent = GREATEST(sent - 1, 0)
    WHERE organization_id = ${organizationId}
      AND period_start = date_trunc('month', now() AT TIME ZONE 'UTC')
  `);
}

/** One-time notices skip the cap: they are how people learn the setup is broken. */
const CAPPED_KINDS: ReadonlySet<string> = new Set([
  "alert",
  "reminder",
  "recovery",
]);

async function sendRow(
  row: DeliveryRow,
  ctx: Context
): Promise<DeliveryOutcome | "capped" | "gone"> {
  const content = await renderRow(row, ctx);
  if (!content) {
    return "gone";
  }

  if (row.channel === "email") {
    // A missed scheduled run is usually our fault, so it never uses the cap.
    const incident = row.incidentId ? await ctx.incident(row.incidentId) : null;
    const counted =
      CAPPED_KINDS.has(row.kind) && incident?.openedBy !== "missed";
    if (counted && !(await reserveEmail(row.organizationId, ctx, row.kind))) {
      return "capped";
    }
    const outcome = await sendEmailMessage(row.recipient, content.rendered);
    if (counted && !outcome.ok) {
      await releaseEmail(row.organizationId, ctx);
    }
    return outcome;
  }

  const channel = row.channelId ? ctx.channels.get(row.channelId) : undefined;
  if (!channel) {
    return {
      ok: false,
      retryable: false,
      channelHealthy: true,
      message: "The channel was removed from the notification settings.",
    };
  }
  return await sendChannelMessage({
    channel,
    organizationId: row.organizationId,
    rendered: content.rendered,
    dedupKey: row.incidentId ? `kh-fa-${row.incidentId}` : undefined,
    pagerDutyAction: row.kind === "recovery" ? "resolve" : "trigger",
    details: content.details,
    link: content.link,
    pagerDutyGroup:
      typeof row.context?.group === "string" ? row.context.group : undefined,
    // A missed run is usually our scheduler, not an emergency of theirs.
    pagerDutySeverity:
      (row.incidentId && (await ctx.incident(row.incidentId))?.openedBy) ===
      "missed"
        ? "warning"
        : "error",
  });
}

async function finishRow(
  row: DeliveryRow,
  state: FailureAlertDeliveryState,
  patch: Partial<typeof failureAlertDeliveries.$inferInsert>
): Promise<void> {
  await db
    .update(failureAlertDeliveries)
    .set({ state, updatedAt: new Date(), ...patch })
    .where(eq(failureAlertDeliveries.id, row.id));
}

/**
 * Stop sending to a broken channel and tell people once: the alert recipients, the
 * owners (who may not be among them) and, for a workflow's own method, the
 * people that workflow emails.
 */
async function stopChannel(
  channelId: string,
  reason: string,
  organizationId: string,
  now: Date
): Promise<boolean> {
  const org = await loadOrgPolicy(organizationId);
  const members = await loadOrgMembers(organizationId);
  const orgEmails = [
    ...resolveRecipientEmails(org.recipientUserIds, members),
    ...reachableEmails(members.filter((m) => m.role === "owner")),
  ];
  // Stop and notice together, so a failed insert never stops a channel silently.
  return await db.transaction(async (tx: Tx) => {
    const stopped = await tx
      .update(failureAlertChannels)
      .set({ stoppedAt: now, stoppedReason: reason })
      .where(
        and(
          eq(failureAlertChannels.id, channelId),
          isNull(failureAlertChannels.stoppedAt)
        )
      )
      .returning({
        kind: failureAlertChannels.kind,
        destination: failureAlertChannels.destination,
        integrationId: failureAlertChannels.integrationId,
        workflowId: failureAlertChannels.workflowId,
      });
    const channel = stopped[0];
    if (!channel) {
      return false;
    }
    const [workflow] = channel.workflowId
      ? await tx
          .select({
            name: workflows.name,
            recipientUserIds: workflowFailureAlertOverrides.recipientUserIds,
          })
          .from(workflows)
          .leftJoin(
            workflowFailureAlertOverrides,
            eq(workflowFailureAlertOverrides.workflowId, workflows.id)
          )
          .where(eq(workflows.id, channel.workflowId))
          .limit(1)
      : [];
    const workflowEmails = workflow?.recipientUserIds
      ? resolveRecipientEmails(workflow.recipientUserIds, members)
      : [];
    const emails = [...new Set([...orgEmails, ...workflowEmails])];
    const [connection] = await tx
      .select({ name: integrations.name })
      .from(integrations)
      .where(eq(integrations.id, channel.integrationId))
      .limit(1);
    await insertDeliveries(
      emails.map((email) => ({
        scope: `stopped:${channelId}:${now.toISOString()}`,
        organizationId,
        incidentId: null,
        kind: "channel_stopped" as const,
        sequence: 0,
        channel: "email" as const,
        recipient: email,
        nextAttemptAt: now,
        context: {
          channelLabel: channelLabel(
            channel.kind,
            channel.destination,
            connection?.name
          ),
          channelKind: channel.kind,
          reason,
          ...(channel.workflowId && workflow
            ? { workflowId: channel.workflowId, workflowName: workflow.name }
            : {}),
        },
      })),
      tx
    );
    return true;
  });
}

async function recordChannelHealth(
  channelId: string | null,
  outcome: DeliveryOutcome,
  now: Date
): Promise<void> {
  if (!channelId) {
    return;
  }
  await db
    .update(failureAlertChannels)
    .set(
      outcome.ok
        ? { lastDeliveredAt: now }
        : { lastFailedAt: now, lastError: outcome.message }
    )
    .where(eq(failureAlertChannels.id, channelId));
}

/** Send due rows in small batches until empty or out of budget. */
export async function drainOutbox(
  appUrl: string,
  stats: DrainStats,
  deadline: number,
  /** The cycle's time, so staleness here agrees with fireBackups. */
  now: Date = new Date()
): Promise<void> {
  const ctx = new Context(appUrl);
  while (Date.now() < deadline) {
    const claimed = await claimDue();
    if (claimed.length === 0) {
      return;
    }
    const { kept, dropped } = splitByRollout(
      claimed,
      (row) => row.organizationId
    );
    await setAsideOutsideRollout(dropped, now);
    const rows = await skipHalted(await dropStale(kept, now), now);
    await ctx.loadChannels(
      rows.map((row) => row.channelId).filter((id): id is string => Boolean(id))
    );
    for (const [index, row] of rows.entries()) {
      if (Date.now() >= deadline) {
        await releaseRows(rows.slice(index));
        return;
      }
      try {
        // Restart this row's clock: it may have waited behind slow sends in
        // its batch, and must not look abandoned to another evaluator.
        await db
          .update(failureAlertDeliveries)
          .set({ updatedAt: new Date(), attempts: row.attempts + 1 })
          .where(eq(failureAlertDeliveries.id, row.id));
        await processRow({ ...row, attempts: row.attempts + 1 }, ctx, stats);
      } catch (error) {
        logSystemError(
          ErrorCategory.EXTERNAL_SERVICE,
          "[FailureAlerts] Delivery crashed; it will be retried",
          error,
          { delivery_id: row.id, channel: row.channel }
        );
        await finishRow(row, "retrying", {
          nextAttemptAt: new Date(Date.now() + RETRY_DELAYS_MS[0]),
          lastError: "Internal error while sending; retrying.",
        });
      }
    }
  }
}

const OUTSIDE_ROLLOUT =
  "Failure notifications are not on for this organization.";

/** Retry delay for a row this process's rollout leaves out. */
const ROLLOUT_RECHECK_MS = 60_000;

/**
 * Rows of orgs outside this process's rollout: another process may be on a wider one mid-deploy,
 * so they wait a minute; once stale (an hour) they are skipped as outside the rollout.
 */
async function setAsideOutsideRollout(
  rows: DeliveryRow[],
  now: Date
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const stale = rows.filter((row) => isStale(row, now)).map((row) => row.id);
  const waiting = rows.filter((row) => !isStale(row, now)).map((row) => row.id);
  if (stale.length > 0) {
    await db
      .update(failureAlertDeliveries)
      .set({ state: "skipped", lastError: OUTSIDE_ROLLOUT, updatedAt: now })
      .where(inArray(failureAlertDeliveries.id, stale));
  }
  if (waiting.length > 0) {
    await db
      .update(failureAlertDeliveries)
      .set({
        state: sql`CASE WHEN ${failureAlertDeliveries.attempts} = 0 THEN 'pending' ELSE 'retrying' END`,
        nextAttemptAt: new Date(now.getTime() + ROLLOUT_RECHECK_MS),
        updatedAt: now,
      })
      .where(inArray(failureAlertDeliveries.id, waiting));
  }
}

/** A PagerDuty resolve only cleans up, so it keeps trying for a day. */
function isPagerDutyResolve(row: DeliveryRow): boolean {
  return row.kind === "recovery" && row.channel === "pagerduty";
}

/** Due over an hour ago, so no longer news: such a row is never sent, nor a backup for it. */
function isStale(row: DeliveryRow, now: Date): boolean {
  const limit = isPagerDutyResolve(row)
    ? PAGERDUTY_RESOLVE_STALE_MS
    : STALE_DELIVERY_MS;
  return now.getTime() - dueSince(row).getTime() >= limit;
}

/** Skip claimed rows that waited too long; returns the rest. */
async function dropStale(
  rows: DeliveryRow[],
  now: Date
): Promise<DeliveryRow[]> {
  const stale = rows.filter((row) => isStale(row, now));
  if (stale.length > 0) {
    await db
      .update(failureAlertDeliveries)
      .set({ state: "skipped", lastError: SKIP_REASON.stale, updatedAt: now })
      .where(
        inArray(
          failureAlertDeliveries.id,
          stale.map((row) => row.id)
        )
      );
  }
  return rows.filter((row) => !stale.includes(row));
}

/** Hand claimed rows the budget did not reach back to the queue, due now. */
async function releaseRows(rows: DeliveryRow[]): Promise<void> {
  for (const row of rows) {
    await finishRow(row, row.attempts === 0 ? "pending" : "retrying", {
      nextAttemptAt: new Date(),
    });
  }
}

/** Incident messages a halted org is not sent (its incidents stay open and quiet). */
const QUIET_WHILE_HALTED: ReadonlySet<string> = new Set([
  "alert",
  "reminder",
  "recovery",
]);

/** Orgs among these that are halted right now. */
async function haltedOrgs(organizationIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(organizationIds)];
  if (ids.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ id: organization.id })
    .from(organization)
    .where(
      and(inArray(organization.id, ids), isNotNull(organization.haltedAt))
    );
  return new Set(rows.map((row) => row.id));
}

/** Halted: skip, not hold, so lifting the halt sends nothing old. A PagerDuty resolve still goes, or the page stays open. */
async function skipHalted(
  rows: DeliveryRow[],
  now: Date
): Promise<DeliveryRow[]> {
  const quietable = rows.filter(
    (row) => QUIET_WHILE_HALTED.has(row.kind) && !isPagerDutyResolve(row)
  );
  const halted = await haltedOrgs(quietable.map((row) => row.organizationId));
  const quiet = new Set(
    quietable
      .filter((row) => halted.has(row.organizationId))
      .map((row) => row.id)
  );
  if (quiet.size > 0) {
    await db
      .update(failureAlertDeliveries)
      .set({ state: "skipped", lastError: SKIP_REASON.halted, updatedAt: now })
      .where(inArray(failureAlertDeliveries.id, [...quiet]));
  }
  return rows.filter((row) => !quiet.has(row.id));
}

/** When a row first became due: backupAt keeps its wait after any hold (org pause; on a recovery it is set only for this). */
function dueSince(row: DeliveryRow): Date {
  const wait = BACKUP_AFTER_MS[row.channel];
  if (row.isBackup || !row.backupAt || wait === undefined) {
    return row.createdAt;
  }
  const due = row.backupAt.getTime() - wait;
  return due > row.createdAt.getTime() ? new Date(due) : row.createdAt;
}

async function processRow(
  row: DeliveryRow,
  ctx: Context,
  stats: DrainStats
): Promise<void> {
  const outcome = await sendRow(row, ctx);
  // The time of this send, not the cycle's start: a long cycle would otherwise
  // make a one-minute retry due at once and date deliveries too early.
  const now = new Date();
  if (outcome === "gone") {
    await finishRow(row, "skipped", {
      lastError: SKIP_REASON.gone,
    });
    return;
  }
  if (outcome === "capped") {
    stats.capped += 1;
    await finishRow(row, "capped", {
      lastError: `The Free plan's ${FREE_PLAN_MONTHLY_EMAILS} alert emails for this month are used.`,
    });
    return;
  }

  if (!outcome.channelHealthy) {
    await recordChannelHealth(row.channelId, outcome, now);
  }

  if (outcome.ok) {
    stats.delivered += 1;
    await finishRow(row, "delivered", {
      deliveredAt: now,
      lastStatus: outcome.status ?? null,
      lastError: null,
    });
    return;
  }

  if (outcome.platformFault) {
    // Our own email key or configuration: page our on-call, and keep
    // retrying, since the customer's alert is still owed once we fix it.
    logSystemError(
      ErrorCategory.INFRASTRUCTURE,
      "[FailureAlerts] Email provider refused our credentials",
      new Error(outcome.message),
      { status: String(outcome.status ?? "") }
    );
  }

  const retryAt = new Date(
    now.getTime() + nextRetryDelayMs(row.attempts, outcome.retryAfterMs)
  );
  // A retry that would land after the hour is dropped anyway: fail now instead.
  const expired = isStale(row, retryAt);
  if ((outcome.retryable || outcome.platformFault) && !expired) {
    stats.retrying += 1;
    await finishRow(row, "retrying", {
      nextAttemptAt: retryAt,
      lastStatus: outcome.status ?? null,
      lastError: outcome.message,
    });
    return;
  }

  stats.failed += 1;
  await finishRow(row, "failed", {
    lastStatus: outcome.status ?? null,
    lastError: outcome.message,
  });
  // An hour of retryable errors may be the provider's outage: the daily check judges the channel.
  if (
    row.channelId &&
    !outcome.channelHealthy &&
    !(expired && outcome.retryable) &&
    (await stopChannel(row.channelId, outcome.message, row.organizationId, now))
  ) {
    stats.channelsStopped += 1;
  }
}

function describeFailure(row: DeliveryRow): string {
  if (row.state === "capped") {
    return "the Free plan's alert emails for this month are used";
  }
  if (row.recipient === "(nobody reachable)") {
    return "nobody in the organization has an email address KeeperHub can reach";
  }
  const name =
    CHANNEL_LABEL[row.channel as keyof typeof CHANNEL_LABEL] ?? row.channel;
  const paged = row.channel === "pagerduty" ? ", so nobody has been paged" : "";
  return `${name} could not deliver it${paged}`;
}

/** Backups for failed or late messages (plus email when email was not what failed). */
export async function fireBackups(now: Date, stats: DrainStats): Promise<void> {
  const due = await db
    .select()
    .from(failureAlertDeliveries)
    .where(
      and(
        eq(failureAlertDeliveries.isBackup, false),
        isNull(failureAlertDeliveries.backupSentAt),
        isNotNull(failureAlertDeliveries.backupAt),
        inArray(failureAlertDeliveries.kind, ["alert", "reminder"]),
        or(
          // A never-sent failed row ("nobody reachable") held by an org pause waits for its end.
          and(
            inArray(failureAlertDeliveries.state, ["failed", "capped"]),
            or(
              gt(failureAlertDeliveries.attempts, 0),
              lte(failureAlertDeliveries.nextAttemptAt, now)
            )
          ),
          and(
            inArray(failureAlertDeliveries.state, [
              "pending",
              "retrying",
              "sending",
            ]),
            lte(failureAlertDeliveries.backupAt, now)
          )
        )
      )
    )
    .orderBy(failureAlertDeliveries.backupAt)
    .limit(100);

  const split = splitByRollout(due, (row) => row.organizationId);
  const halted = await haltedOrgs(split.kept.map((row) => row.organizationId));
  const kept = split.kept.filter(
    (row) => !(isStale(row, now) || halted.has(row.organizationId))
  );
  // Outside the rollout, halted, or due over an hour ago: no backup is owed; mark them so they stop crowding the list.
  const dropped = due.filter((row) => !kept.includes(row));
  if (dropped.length > 0) {
    await db
      .update(failureAlertDeliveries)
      .set({ backupSentAt: now })
      .where(
        inArray(
          failureAlertDeliveries.id,
          dropped.map((row) => row.id)
        )
      );
  }

  for (const row of kept) {
    try {
      const claimed = await db
        .update(failureAlertDeliveries)
        .set({ backupSentAt: now })
        .where(
          and(
            eq(failureAlertDeliveries.id, row.id),
            isNull(failureAlertDeliveries.backupSentAt)
          )
        )
        .returning({ id: failureAlertDeliveries.id });
      if (claimed.length === 0) {
        continue;
      }
      try {
        stats.backupsQueued += await queueBackupFor(row, now);
      } catch (error) {
        // Hand the claim back so the next cycle tries again.
        await db
          .update(failureAlertDeliveries)
          .set({ backupSentAt: null })
          .where(eq(failureAlertDeliveries.id, row.id));
        throw error;
      }
    } catch (error) {
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[FailureAlerts] Could not queue a backup",
        error,
        { delivery_id: row.id }
      );
    }
  }
}

async function queueBackupFor(row: DeliveryRow, now: Date): Promise<number> {
  const scope = scopeOf(row);
  // Same message, every destination: what already got it needs no backup.
  const siblings = await db
    .select({
      channel: failureAlertDeliveries.channel,
      recipient: failureAlertDeliveries.recipient,
      state: failureAlertDeliveries.state,
    })
    .from(failureAlertDeliveries)
    .where(
      and(
        eq(failureAlertDeliveries.organizationId, row.organizationId),
        row.incidentId
          ? eq(failureAlertDeliveries.incidentId, row.incidentId)
          : sql`${failureAlertDeliveries.dedupKey} LIKE ${`${scope}|%`}`,
        eq(failureAlertDeliveries.kind, row.kind),
        eq(failureAlertDeliveries.sequence, row.sequence)
      )
    );

  // Email reached someone: one bounced address is not an outage.
  if (
    row.channel === "email" &&
    siblings.some((s) => s.channel === "email" && s.state === "delivered")
  ) {
    return 0;
  }

  const incident = row.incidentId
    ? (
        await db
          .select({
            workflowId: workflowFailureIncidents.workflowId,
            resolvedAt: workflowFailureIncidents.resolvedAt,
          })
          .from(workflowFailureIncidents)
          .where(eq(workflowFailureIncidents.id, row.incidentId))
          .limit(1)
      )[0]
    : undefined;
  if (incident?.resolvedAt) {
    return 0;
  }
  // A grouped alert follows the org's setup; a single one its workflow's.
  const policy = incident
    ? await loadEffectivePolicy(row.organizationId, incident.workflowId)
    : null;
  const org = policy ? null : await loadOrgPolicy(row.organizationId);
  const channels =
    policy?.channels ?? (await loadChannels(row.organizationId, null));
  const recipientUserIds =
    policy?.recipientUserIds ?? org?.recipientUserIds ?? null;
  // Nothing goes out during an org pause, whatever queued the backup.
  const sendAt =
    activePause(policy?.orgPausedUntil ?? org?.pausedUntil ?? null, now) ?? now;

  const targets: DeliveryInsert[] = [];
  // Any skipped copy (withdrawn, dropped, halted) reached nobody, so it does not count.
  const has = (channel: string, recipient: string): boolean =>
    siblings.some(
      (s) =>
        s.channel === channel &&
        s.recipient === recipient &&
        s.state !== "skipped"
    );
  const reason = describeFailure(row);
  const base = {
    scope,
    organizationId: row.organizationId,
    incidentId: row.incidentId,
    kind: row.kind,
    sequence: row.sequence,
    isBackup: true,
    nextAttemptAt: sendAt,
    context: { ...(row.context ?? {}), backupReason: reason },
  };

  for (const channel of channels) {
    if (channel.stoppedAt || channel.role !== "backup") {
      continue;
    }
    if (
      channel.kind === "pagerduty" &&
      (row.kind !== "alert" || !row.incidentId)
    ) {
      continue;
    }
    const recipient = channelRecipient(channel);
    if (has(channel.kind, recipient)) {
      continue;
    }
    targets.push({
      ...base,
      channel: channel.kind,
      channelId: channel.id,
      recipient,
    });
  }

  if (row.channel !== "email") {
    const emails = resolveRecipientEmails(
      recipientUserIds,
      await loadOrgMembers(row.organizationId)
    );
    // A page that did not go out is news even to someone who already has the
    // alert by email: it means nobody on call was woken.
    const pageFailed = row.channel === "pagerduty";
    for (const email of emails) {
      if (!pageFailed && has("email", email)) {
        continue;
      }
      targets.push({ ...base, channel: "email", recipient: email });
    }
  }

  if (targets.length === 0) {
    logSystemWarn(
      ErrorCategory.EXTERNAL_SERVICE,
      "[FailureAlerts] A failure alert could not be delivered and has no backup",
      new Error(reason),
      { organization_id: row.organizationId, delivery_id: row.id }
    );
    return 0;
  }
  return await insertDeliveries(targets);
}

const HEALTH_CHECKS_PER_CYCLE = 20;
/** Channels read per cycle: ones outside the rollout stay due, so the scan pages through them. */
const HEALTH_SCAN_PAGE = 500;
/** Per pod: a restart or another pod starts from the top, which only repeats checks. */
let healthScanCursor: string | null = null;

/** Daily silent check: stop dead channels, restore stopped ones that work again. */
export async function runHealthChecks(
  now: Date,
  stats: DrainStats
): Promise<void> {
  const rows = await db
    .select({
      id: failureAlertChannels.id,
      organizationId: failureAlertChannels.organizationId,
      kind: failureAlertChannels.kind,
      integrationId: failureAlertChannels.integrationId,
      destination: failureAlertChannels.destination,
      role: failureAlertChannels.role,
      stoppedAt: failureAlertChannels.stoppedAt,
    })
    .from(failureAlertChannels)
    .where(
      and(
        or(
          isNull(failureAlertChannels.lastHealthCheckAt),
          lt(
            failureAlertChannels.lastHealthCheckAt,
            new Date(now.getTime() - HEALTH_CHECK_INTERVAL_MS)
          )
        ),
        healthScanCursor
          ? gt(failureAlertChannels.id, healthScanCursor)
          : undefined
      )
    )
    .orderBy(failureAlertChannels.id)
    .limit(HEALTH_SCAN_PAGE);
  const kept = splitByRollout(rows, (row) => row.organizationId).kept;
  const due = kept.slice(0, HEALTH_CHECKS_PER_CYCLE);
  // Resume after the last channel taken, or from the top once the list ends.
  if (kept.length > due.length) {
    healthScanCursor = due.at(-1)?.id ?? null;
  } else {
    healthScanCursor =
      rows.length < HEALTH_SCAN_PAGE ? null : (rows.at(-1)?.id ?? null);
  }

  for (const channel of due) {
    try {
      const outcome = await checkChannelSilently(
        channel,
        channel.organizationId
      );
      stats.healthChecks += 1;
      await db
        .update(failureAlertChannels)
        .set({
          lastHealthCheckAt: now,
          // Slack's check only proves the token, not the channel, so a stopped
          // Slack channel comes back only through a Test.
          ...(channel.stoppedAt && outcome.ok && channel.kind !== "slack"
            ? { stoppedAt: null, stoppedReason: null }
            : {}),
        })
        .where(eq(failureAlertChannels.id, channel.id));
      if (!(outcome.ok || outcome.retryable || channel.stoppedAt)) {
        await recordChannelHealth(channel.id, outcome, now);
        if (
          await stopChannel(
            channel.id,
            `The daily check found it no longer works: ${outcome.message}`,
            channel.organizationId,
            now
          )
        ) {
          stats.channelsStopped += 1;
        }
      }
    } catch (error) {
      logSystemWarn(
        ErrorCategory.EXTERNAL_SERVICE,
        "[FailureAlerts] Channel health check crashed",
        error,
        { channel_id: channel.id }
      );
    }
  }
}

/** Prune past RETENTION_DAYS a few thousand rows per cycle, avoiding long locks. */
export async function pruneOldRecords(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await db.execute(sql`
    DELETE FROM ${failureAlertDeliveries}
    WHERE id IN (
      SELECT d.id FROM ${failureAlertDeliveries} d
      WHERE d.created_at < ${cutoff.toISOString()}::timestamptz AT TIME ZONE 'UTC'
        AND NOT EXISTS (
          SELECT 1 FROM ${workflowFailureIncidents} i
          WHERE i.id = d.incident_id AND i.resolved_at IS NULL
        )
        -- A grouped alert names its incidents: kept while any is open, so its recovery reaches the same people.
        AND NOT (d.incident_id IS NULL AND EXISTS (
          SELECT 1 FROM ${workflowFailureIncidents} i
          WHERE i.resolved_at IS NULL
            AND jsonb_typeof(d.context->'incidentIds') = 'array'
            AND i.id IN (SELECT jsonb_array_elements_text(d.context->'incidentIds'))
        ))
      LIMIT 5000
    )
  `);
  await db.delete(workflowFailureIncidents).where(
    inArray(
      workflowFailureIncidents.id,
      db
        .select({ id: workflowFailureIncidents.id })
        .from(workflowFailureIncidents)
        .where(
          and(
            isNotNull(workflowFailureIncidents.resolvedAt),
            lt(workflowFailureIncidents.resolvedAt, cutoff)
          )
        )
        .limit(1000)
    )
  );
}
