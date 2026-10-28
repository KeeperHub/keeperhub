import "server-only";

import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
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
import {
  FREE_PLAN_MONTHLY_EMAILS,
  GIVE_UP_AFTER_MS,
  HEALTH_CHECK_INTERVAL_MS,
  MAX_DELIVERIES_PER_RUN,
  RETRY_DELAYS_MS,
  STALE_SENDING_MS,
} from "./constants";
import { workflowTriggerType } from "./evaluator";
import {
  type AlertWorkflow,
  type MessageInput,
  type RenderedMessage,
  renderMessage,
  runsUrl,
} from "./messages";
import {
  type ChannelConfig,
  loadChannelsByIds,
  loadEffectivePolicy,
  loadOrgMembers,
  loadOrgPolicy,
  resolveRecipientEmails,
} from "./policy";
import {
  checkChannelSilently,
  type DeliveryOutcome,
  sendChannelMessage,
  sendEmailMessage,
} from "./senders";

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

const CHANNEL_NAMES: Record<string, string> = {
  email: "Email",
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
  pagerduty: "PagerDuty",
};

export function channelLabel(
  kind: string,
  destination: string,
  connectionName?: string | null
): string {
  const name = CHANNEL_NAMES[kind] ?? kind;
  const where = kind === "discord" ? connectionName : destination;
  return where ? `${name} ${where}` : name;
}

/** Delay before the next attempt, honouring a provider's Retry-After. */
export function nextRetryDelayMs(
  attempts: number,
  retryAfterMs: number | undefined
): number {
  const index = Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1);
  return Math.max(RETRY_DELAYS_MS[index], retryAfterMs ?? 0);
}

/**
 * Claim due rows. "sending" rows older than two minutes belong to an
 * evaluator that died mid-send and are taken over.
 */
async function claimDue(): Promise<DeliveryRow[]> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE ${failureAlertDeliveries}
    SET state = 'sending', attempts = attempts + 1, updated_at = now()
    WHERE id IN (
      SELECT id FROM ${failureAlertDeliveries}
      WHERE (state IN ('pending', 'retrying') AND next_attempt_at <= now())
         OR (state = 'sending' AND updated_at < now() - (${STALE_SENDING_MS} * interval '1 millisecond'))
      ORDER BY next_attempt_at
      LIMIT ${MAX_DELIVERIES_PER_RUN}
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
  channels = new Map<string, ChannelConfig>();
  readonly appUrl: string;

  constructor(appUrl: string) {
    this.appUrl = appUrl;
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

/** Build what one outbox row says. Null when what it was about is gone. */
async function renderRow(
  row: DeliveryRow,
  ctx: Context
): Promise<{
  rendered: RenderedMessage;
  details?: Record<string, unknown>;
} | null> {
  const orgName = await ctx.orgName(row.organizationId);
  const context = row.context ?? {};
  const backupReason =
    typeof context.backupReason === "string" ? context.backupReason : undefined;
  let input: MessageInput;

  if (row.kind === "channel_paused") {
    input = {
      kind: "channel_paused",
      orgName,
      channelLabel: String(context.channelLabel ?? "A channel"),
      reason: String(context.reason ?? ""),
      appUrl: ctx.appUrl,
      organizationId: row.organizationId,
    };
  } else if (row.kind === "launch_notice") {
    input = {
      kind: "launch_notice",
      orgName,
      threshold: (await loadOrgPolicy(row.organizationId)).threshold,
      failingNow: (context.failingNow ?? []) as (AlertWorkflow & {
        failureCount: number;
      })[],
      appUrl: ctx.appUrl,
      organizationId: row.organizationId,
    };
  } else if (Array.isArray(context.incidentIds)) {
    const list: (AlertWorkflow & { failureCount: number })[] = [];
    for (const id of context.incidentIds as string[]) {
      const incident = await ctx.incident(id);
      const workflow = incident
        ? await ctx.workflow(incident.workflowId)
        : null;
      if (incident && workflow && !incident.resolvedAt) {
        list.push({ ...workflow, failureCount: incident.failureCount });
      }
    }
    if (list.length === 0) {
      return null;
    }
    input = {
      kind: "grouped",
      orgName,
      workflows: list,
      appUrl: ctx.appUrl,
      backupReason,
    };
  } else {
    const incident = row.incidentId ? await ctx.incident(row.incidentId) : null;
    const workflow = incident ? await ctx.workflow(incident.workflowId) : null;
    if (!(incident && workflow)) {
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
        ? {
            kind: "recovery",
            orgName,
            workflow,
            incident: alertIncident,
            appUrl: ctx.appUrl,
          }
        : {
            kind: row.kind === "reminder" ? "reminder" : "alert",
            orgName,
            workflow,
            incident: alertIncident,
            appUrl: ctx.appUrl,
            backupReason,
          };
    return {
      rendered: renderMessage(input),
      details: {
        organization: orgName,
        workflow: workflow.name,
        trigger: workflow.triggerLabel,
        failing_since: incident.firstFailedAt.toISOString(),
        failed_runs_in_a_row: incident.failureCount,
        last_error: incident.lastError,
        runs: runsUrl(ctx.appUrl, workflow.id),
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
    // The cap is on alerts. One-time notices (notifications switched on, a
    // channel paused) are rare and are how people learn the setup is broken.
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
export async function pauseChannel(
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
  if (emails.length > 0) {
    await db
      .insert(failureAlertDeliveries)
      .values(
        emails.map((email) => ({
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
      )
      .onConflictDoNothing();
  }
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

/** Send everything due and record what happened. */
export async function drainOutbox(
  now: Date,
  appUrl: string,
  stats: DrainStats
): Promise<void> {
  const rows = await claimDue();
  if (rows.length === 0) {
    return;
  }
  const ctx = new Context(appUrl);
  ctx.channels = await loadChannelsByIds(
    rows.map((row) => row.channelId).filter((id): id is string => Boolean(id))
  );

  for (const row of rows) {
    try {
      await processRow(row, ctx, now, stats);
    } catch (error) {
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[FailureAlerts] Delivery crashed; it will be retried",
        error,
        { delivery_id: row.id, channel: row.channel }
      );
      await finishRow(row, "retrying", {
        nextAttemptAt: new Date(now.getTime() + RETRY_DELAYS_MS[0]),
        lastError: "Internal error while sending; retrying.",
      });
    }
  }
}

async function processRow(
  row: DeliveryRow,
  ctx: Context,
  now: Date,
  stats: DrainStats
): Promise<void> {
  const outcome = await sendRow(row, ctx);
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

  await recordChannelHealth(row.channelId, outcome, now);

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
    // Our own email key or configuration: page our on-call, not the customer.
    logSystemError(
      ErrorCategory.INFRASTRUCTURE,
      "[FailureAlerts] Email provider refused our credentials",
      new Error(outcome.message),
      { status: String(outcome.status ?? "") }
    );
  }

  const expired = now.getTime() - row.createdAt.getTime() >= GIVE_UP_AFTER_MS;
  if (outcome.retryable && !expired) {
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
  if (row.channelId && !outcome.platformFault) {
    const reason = expired
      ? `It has failed for 24 hours: ${outcome.message}`
      : outcome.message;
    if (await pauseChannel(row.channelId, reason, row.organizationId, now)) {
      stats.channelsPaused += 1;
    }
  }
}

function describeFailure(row: DeliveryRow): string {
  const name = CHANNEL_NAMES[row.channel] ?? row.channel;
  if (row.state === "capped") {
    return "the Free plan's alert emails for this month are used";
  }
  if (row.recipient === "(nobody reachable)") {
    return "nobody in the organization has an email address KeeperHub can reach";
  }
  const status = row.lastStatus ? ` (HTTP ${row.lastStatus})` : "";
  const paged =
    row.channel === "pagerduty" ? ", nobody has been paged yet" : "";
  return `${name} could not be reached${status}${paged}`;
}

/**
 * Plan B. A message that failed for good, or is still not delivered when its
 * backup time comes, goes to the backup channels and, when it was not email
 * that failed, to the email recipients too. Claimed per row, and the unique
 * key stops two rows of the same message queuing the same backup twice.
 */
export async function fireBackups(now: Date, stats: DrainStats): Promise<void> {
  const due = await db
    .select()
    .from(failureAlertDeliveries)
    .where(
      and(
        eq(failureAlertDeliveries.isBackup, false),
        inArray(failureAlertDeliveries.kind, ["alert", "reminder"]),
        isNull(failureAlertDeliveries.backupSentAt),
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
      stats.backupsQueued += await queueBackupFor(row, now);
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
  // Same message, every destination: what already got it needs no backup.
  const siblings = await db
    .select({
      channel: failureAlertDeliveries.channel,
      channelId: failureAlertDeliveries.channelId,
      recipient: failureAlertDeliveries.recipient,
      state: failureAlertDeliveries.state,
    })
    .from(failureAlertDeliveries)
    .where(
      and(
        eq(failureAlertDeliveries.organizationId, row.organizationId),
        row.incidentId
          ? eq(failureAlertDeliveries.incidentId, row.incidentId)
          : sql`${failureAlertDeliveries.context} = ${JSON.stringify(row.context ?? {})}::jsonb`,
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
          .select({ workflowId: workflowFailureIncidents.workflowId })
          .from(workflowFailureIncidents)
          .where(eq(workflowFailureIncidents.id, row.incidentId))
          .limit(1)
      )[0]
    : undefined;
  const policy = incident
    ? await loadEffectivePolicy(row.organizationId, incident.workflowId)
    : null;
  const org = policy ? null : await loadOrgPolicy(row.organizationId);
  const channels = policy?.channels ?? [];

  const targets: (typeof failureAlertDeliveries.$inferInsert)[] = [];
  const has = (channel: string, recipient: string): boolean =>
    siblings.some((s) => s.channel === channel && s.recipient === recipient);
  const reason = describeFailure(row);

  for (const channel of channels) {
    if (channel.pausedAt || channel.role !== "backup") {
      continue;
    }
    if (channel.kind === "pagerduty" && row.kind !== "alert") {
      continue;
    }
    const recipient = channel.destination || channel.kind;
    if (has(channel.kind, recipient)) {
      continue;
    }
    targets.push({
      organizationId: row.organizationId,
      incidentId: row.incidentId,
      kind: row.kind,
      sequence: row.sequence,
      channel: channel.kind,
      channelId: channel.id,
      recipient,
      isBackup: true,
      nextAttemptAt: now,
      context: { ...(row.context ?? {}), backupReason: reason },
    });
  }

  if (row.channel !== "email") {
    const emails = resolveRecipientEmails(
      policy?.recipientUserIds ?? org?.recipientUserIds ?? null,
      await loadOrgMembers(row.organizationId)
    );
    // A page that did not go out is news even to someone who already has the
    // alert by email: it means nobody on call was woken.
    const pageFailed = row.channel === "pagerduty";
    for (const email of emails) {
      if (!pageFailed && has("email", email)) {
        continue;
      }
      targets.push({
        organizationId: row.organizationId,
        incidentId: row.incidentId,
        kind: row.kind,
        sequence: row.sequence,
        channel: "email",
        recipient: email,
        isBackup: true,
        nextAttemptAt: now,
        context: { ...(row.context ?? {}), backupReason: reason },
      });
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
  const inserted = await db
    .insert(failureAlertDeliveries)
    .values(targets)
    .onConflictDoNothing()
    .returning({ id: failureAlertDeliveries.id });
  return inserted.length;
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
