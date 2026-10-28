import "server-only";

import {
  and,
  eq,
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
  workflowFailureIncidents,
  workflows,
} from "@/lib/db/schema";
import type { FailureAlertDeliveryState } from "@/lib/db/schema-failure-alerts";
import { ErrorCategory, logSystemError, logSystemWarn } from "@/lib/logging";
import { loadOrgMembers } from "@/lib/notifications/org-recipients";
import {
  DELIVERY_BATCH,
  FREE_PLAN_MONTHLY_EMAILS,
  GIVE_UP_AFTER_MS,
  HEALTH_CHECK_INTERVAL_MS,
  RETENTION_DAYS,
  RETRY_DELAYS_MS,
  STALE_SENDING_MS,
} from "./constants";
import {
  type AlertWorkflow,
  type MessageInput,
  type RenderedMessage,
  renderMessage,
  runsUrl,
} from "./messages";
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
import {
  checkChannelSilently,
  type DeliveryOutcome,
  sendChannelMessage,
  sendEmailMessage,
} from "./senders";
import { CHANNEL_LABEL, channelLabel } from "./view-types";
import { workflowTriggerType } from "./workflow-trigger";

type DeliveryRow = typeof failureAlertDeliveries.$inferSelect;
type IncidentRow = typeof workflowFailureIncidents.$inferSelect;

export type DrainStats = {
  delivered: number;
  retrying: number;
  failed: number;
  capped: number;
  backupsQueued: number;
  channelsPaused: number;
  healthChecks: number;
};

export function emptyDrainStats(): DrainStats {
  return {
    delivered: 0,
    retrying: 0,
    failed: 0,
    capped: 0,
    backupsQueued: 0,
    channelsPaused: 0,
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

/**
 * Claim a few due rows. "sending" rows untouched for STALE_SENDING_MS belong
 * to an evaluator that died mid-send and are taken over.
 */
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
}

type Rendered = {
  rendered: RenderedMessage;
  details?: Record<string, unknown>;
  link?: string;
};

/** Build what one outbox row says. Null when what it was about is gone. */
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

  if (row.kind === "channel_paused") {
    input = {
      ...org,
      kind: "channel_paused",
      channelLabel: String(context.channelLabel ?? "A channel"),
      reason: String(context.reason ?? ""),
    };
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
    const list: Extract<MessageInput, { kind: "grouped" }>["workflows"] = [];
    for (const id of context.incidentIds as string[]) {
      const incident = await ctx.incident(id);
      const workflow = incident
        ? await ctx.workflow(incident.workflowId)
        : null;
      if (incident && workflow && !incident.resolvedAt) {
        list.push({
          ...workflow,
          failureCount: incident.failureCount,
          workflowPaused: incident.workflowPausedAt !== null,
        });
      }
    }
    if (list.length === 0) {
      return null;
    }
    input = { ...org, kind: "grouped", workflows: list, backupReason };
  } else {
    const incident = row.incidentId ? await ctx.incident(row.incidentId) : null;
    const workflow = incident ? await ctx.workflow(incident.workflowId) : null;
    // A "still failing" message must not land after the workflow recovered,
    // e.g. a row taken over from a crashed evaluator after the close.
    const stale = row.kind !== "recovery" && Boolean(incident?.resolvedAt);
    if (!(incident && workflow) || stale) {
      return null;
    }
    const alertIncident = {
      failureCount: incident.failureCount,
      firstFailedAt: incident.firstFailedAt,
      lastError: incident.lastError,
      openedBy: incident.openedBy,
    };
    input =
      row.kind === "recovery"
        ? { ...org, kind: "recovery", workflow, incident: alertIncident }
        : {
            ...org,
            kind: row.kind === "reminder" ? "reminder" : "alert",
            workflow,
            incident: alertIncident,
            backupReason,
            // An alert says so when its incident paused the workflow; a
            // reminder only when it was queued for pausing it again.
            workflowPaused:
              row.kind === "reminder"
                ? context.pausedAgain === true
                : incident.workflowPausedAt !== null,
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
        last_error: incident.lastError,
        runs: link,
      },
    };
  }
  return { rendered: renderMessage(input) };
}

/**
 * Reserve one email against the Free plan's monthly allowance. Returns false
 * when the allowance is used up. Paid plans are never capped.
 */
async function reserveEmail(
  organizationId: string,
  ctx: Context
): Promise<boolean> {
  if ((await ctx.plan(organizationId)) !== "free") {
    return true;
  }
  const rows = await db.execute<{ sent: number }>(sql`
    INSERT INTO ${failureAlertEmailUsage} (organization_id, period_start, sent)
    VALUES (${organizationId}, date_trunc('month', now() AT TIME ZONE 'UTC'), 1)
    ON CONFLICT (organization_id, period_start) DO UPDATE
      SET sent = ${failureAlertEmailUsage}.sent + 1
      WHERE ${failureAlertEmailUsage}.sent < ${FREE_PLAN_MONTHLY_EMAILS}
    RETURNING sent
  `);
  return [...rows].length > 0;
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

/**
 * The cap is on alert emails. One-time notices (notifications switched on, a
 * channel paused) are rare and are how people learn the setup is broken.
 */
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
    const counted = CAPPED_KINDS.has(row.kind);
    if (counted && !(await reserveEmail(row.organizationId, ctx))) {
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
 * Pause a chat or PagerDuty channel that cannot work until someone fixes it,
 * and tell the people who receive failure emails, once.
 */
async function pauseChannel(
  channelId: string,
  reason: string,
  organizationId: string,
  now: Date
): Promise<boolean> {
  const paused = await db
    .update(failureAlertChannels)
    .set({ pausedAt: now, pausedReason: reason })
    .where(
      and(
        eq(failureAlertChannels.id, channelId),
        isNull(failureAlertChannels.pausedAt)
      )
    )
    .returning({
      kind: failureAlertChannels.kind,
      destination: failureAlertChannels.destination,
      integrationId: failureAlertChannels.integrationId,
    });
  const channel = paused[0];
  if (!channel) {
    return false;
  }
  const [connection] = await db
    .select({ name: integrations.name })
    .from(integrations)
    .where(eq(integrations.id, channel.integrationId))
    .limit(1);
  const org = await loadOrgPolicy(organizationId);
  const emails = resolveRecipientEmails(
    org.recipientUserIds,
    await loadOrgMembers(organizationId)
  );
  await insertDeliveries(
    emails.map((email) => ({
      scope: `paused:${channelId}:${now.toISOString()}`,
      organizationId,
      incidentId: null,
      kind: "channel_paused" as const,
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
        reason,
      },
    }))
  );
  return true;
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

/**
 * Send everything due, a small batch at a time, until the queue is empty or
 * the time budget is spent.
 */
export async function drainOutbox(
  appUrl: string,
  stats: DrainStats,
  deadline: number
): Promise<void> {
  const ctx = new Context(appUrl);
  while (Date.now() < deadline) {
    const rows = await claimDue();
    if (rows.length === 0) {
      return;
    }
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

/** Hand claimed rows the budget did not reach back to the queue, due now. */
async function releaseRows(rows: DeliveryRow[]): Promise<void> {
  for (const row of rows) {
    await finishRow(row, row.attempts === 0 ? "pending" : "retrying", {
      nextAttemptAt: new Date(),
    });
  }
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
      lastError: "What this message was about no longer exists.",
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

  const expired = now.getTime() - row.createdAt.getTime() >= GIVE_UP_AFTER_MS;
  if ((outcome.retryable || outcome.platformFault) && !expired) {
    stats.retrying += 1;
    await finishRow(row, "retrying", {
      nextAttemptAt: new Date(
        now.getTime() + nextRetryDelayMs(row.attempts, outcome.retryAfterMs)
      ),
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
  if (row.channelId && !outcome.channelHealthy) {
    const reason = expired
      ? `It has failed for 24 hours: ${outcome.message}`
      : outcome.message;
    if (await pauseChannel(row.channelId, reason, row.organizationId, now)) {
      stats.channelsPaused += 1;
    }
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

/**
 * Plan B. A message that failed for good, or is still not delivered when its
 * backup time comes, goes to the backup channels and, when it was not email
 * that failed, to the email recipients too. Claimed per row, and the dedup
 * key stops two rows of the same message queuing the same backup twice.
 */
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
          inArray(failureAlertDeliveries.state, ["failed", "capped"]),
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
    .limit(100);

  for (const row of due) {
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
  const channels =
    policy?.channels ?? (await loadChannels(row.organizationId, null));
  const recipientUserIds = policy
    ? policy.recipientUserIds
    : (await loadOrgPolicy(row.organizationId)).recipientUserIds;

  const targets: DeliveryInsert[] = [];
  const has = (channel: string, recipient: string): boolean =>
    siblings.some((s) => s.channel === channel && s.recipient === recipient);
  const reason = describeFailure(row);
  const base = {
    scope,
    organizationId: row.organizationId,
    incidentId: row.incidentId,
    kind: row.kind,
    sequence: row.sequence,
    isBackup: true,
    nextAttemptAt: now,
    context: { ...(row.context ?? {}), backupReason: reason },
  };

  for (const channel of channels) {
    if (channel.pausedAt || channel.role !== "backup") {
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

/**
 * The weekly silent check: confirm each channel still works without sending
 * anything a person would see. A channel that is dead for good is paused and
 * the org is told before a real alert needs it.
 */
export async function runHealthChecks(
  now: Date,
  stats: DrainStats
): Promise<void> {
  const due = await db
    .select({
      id: failureAlertChannels.id,
      organizationId: failureAlertChannels.organizationId,
      kind: failureAlertChannels.kind,
      integrationId: failureAlertChannels.integrationId,
      destination: failureAlertChannels.destination,
      role: failureAlertChannels.role,
      pausedAt: failureAlertChannels.pausedAt,
    })
    .from(failureAlertChannels)
    .where(
      and(
        isNull(failureAlertChannels.pausedAt),
        or(
          isNull(failureAlertChannels.lastHealthCheckAt),
          lt(
            failureAlertChannels.lastHealthCheckAt,
            new Date(now.getTime() - HEALTH_CHECK_INTERVAL_MS)
          )
        )
      )
    )
    .limit(20);

  for (const channel of due) {
    try {
      const outcome = await checkChannelSilently(
        channel,
        channel.organizationId
      );
      stats.healthChecks += 1;
      await db
        .update(failureAlertChannels)
        .set({ lastHealthCheckAt: now })
        .where(eq(failureAlertChannels.id, channel.id));
      if (!(outcome.ok || outcome.retryable)) {
        await recordChannelHealth(channel.id, outcome, now);
        if (
          await pauseChannel(
            channel.id,
            `The weekly check found it no longer works: ${outcome.message}`,
            channel.organizationId,
            now
          )
        ) {
          stats.channelsPaused += 1;
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

/**
 * Keep history and incidents for RETENTION_DAYS. A few thousand rows per
 * cycle, so a backlog clears over a few minutes without long locks.
 */
export async function pruneOldRecords(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await db.execute(sql`
    DELETE FROM ${failureAlertDeliveries}
    WHERE id IN (
      SELECT id FROM ${failureAlertDeliveries}
      WHERE created_at < ${cutoff.toISOString()}::timestamptz AT TIME ZONE 'UTC'
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
