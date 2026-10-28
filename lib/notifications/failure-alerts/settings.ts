import "server-only";

import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
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
  orgFailureAlertSettings,
  workflowFailureAlertOverrides,
  workflowFailureAlertQueue,
  workflowFailureIncidents,
  workflows,
} from "@/lib/db/schema";
import type {
  FailureAlertChannelKind,
  FailureAlertChannelRole,
} from "@/lib/db/schema-failure-alerts";
import { isPagerDutyId } from "@/plugins/pagerduty/steps/pagerduty-core";
import {
  FREE_PLAN_MONTHLY_EMAILS,
  HISTORY_PAGE_SIZE,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  TIME_LIMIT_OPTIONS_MINUTES,
} from "./constants";
import {
  loadOrgMembers,
  loadOrgPolicy,
  type OrgMember,
  resolveRecipientEmails,
} from "./policy";
import { isFailureAlertsEnabledForOrg } from "./rollout";
import type {
  ChannelView,
  ConnectionView,
  HistoryEntry,
  MemberView,
  OrgSettingsView,
} from "./view-types";

export type {
  ChannelView,
  ConnectionView,
  HistoryEntry,
  MemberView,
  OrgSettingsView,
} from "./view-types";

export const CHANNEL_KINDS: readonly FailureAlertChannelKind[] = [
  "slack",
  "discord",
  "telegram",
  "pagerduty",
];

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

export function toMemberView(m: OrgMember): MemberView {
  return {
    userId: m.userId,
    role: m.role,
    email: m.deliverable ?? m.email,
    name: m.name,
    reachable: Boolean(m.deliverable),
  };
}

export async function loadChannelViews(
  organizationId: string,
  workflowId: string | null
): Promise<ChannelView[]> {
  const rows = await db
    .select({
      channel: failureAlertChannels,
      connectionName: integrations.name,
    })
    .from(failureAlertChannels)
    .leftJoin(
      integrations,
      eq(integrations.id, failureAlertChannels.integrationId)
    )
    .where(
      and(
        eq(failureAlertChannels.organizationId, organizationId),
        workflowId === null
          ? isNull(failureAlertChannels.workflowId)
          : eq(failureAlertChannels.workflowId, workflowId)
      )
    )
    .orderBy(failureAlertChannels.createdAt);
  return rows.map(({ channel, connectionName }) => ({
    id: channel.id,
    kind: channel.kind,
    integrationId: channel.integrationId,
    connectionName,
    destination: channel.destination,
    role: channel.role,
    pausedAt: iso(channel.pausedAt),
    pausedReason: channel.pausedReason,
    lastDeliveredAt: iso(channel.lastDeliveredAt),
    lastFailedAt: iso(channel.lastFailedAt),
    lastError: channel.lastError,
    lastTestedAt: iso(channel.lastTestedAt),
    lastTestOk: channel.lastTestOk,
  }));
}

/** Connections every member of the org may use, of a kind that can alert. */
export async function loadUsableConnections(
  organizationId: string
): Promise<ConnectionView[]> {
  const rows = await db
    .select({
      id: integrations.id,
      name: integrations.name,
      type: integrations.type,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.organizationId, organizationId),
        eq(integrations.visibility, "organization"),
        inArray(integrations.type, [...CHANNEL_KINDS])
      )
    )
    .orderBy(integrations.name);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.type as FailureAlertChannelKind,
  }));
}

async function loadEmailUsage(
  organizationId: string
): Promise<{ used: number; limit: number } | null> {
  if ((await getOrgPlan(organizationId)) !== "free") {
    return null;
  }
  const rows = await db.execute<{ sent: number }>(sql`
    SELECT sent FROM ${failureAlertEmailUsage}
    WHERE organization_id = ${organizationId}
      AND period_start = date_trunc('month', now() AT TIME ZONE 'UTC')
  `);
  return { used: [...rows][0]?.sent ?? 0, limit: FREE_PLAN_MONTHLY_EMAILS };
}

export function isReachable(
  emails: string[],
  channels: { pausedAt: string | Date | null }[]
): boolean {
  return emails.length > 0 || channels.some((c) => !c.pausedAt);
}

export async function loadOrgSettingsView(
  organizationId: string
): Promise<OrgSettingsView> {
  const [policy, members, channels, connections, emailUsage, custom] =
    await Promise.all([
      loadOrgPolicy(organizationId),
      loadOrgMembers(organizationId),
      loadChannelViews(organizationId, null),
      loadUsableConnections(organizationId),
      loadEmailUsage(organizationId),
      db
        .select({ id: workflows.id, name: workflows.name })
        .from(workflowFailureAlertOverrides)
        .innerJoin(
          workflows,
          eq(workflows.id, workflowFailureAlertOverrides.workflowId)
        )
        .where(
          and(
            eq(workflowFailureAlertOverrides.organizationId, organizationId),
            isNull(workflows.deletedAt),
            or(
              isNotNull(workflowFailureAlertOverrides.threshold),
              isNotNull(workflowFailureAlertOverrides.timeLimitMinutes),
              isNotNull(workflowFailureAlertOverrides.recipientUserIds),
              eq(workflowFailureAlertOverrides.customChannels, true),
              isNotNull(workflowFailureAlertOverrides.mutedUntil),
              eq(workflowFailureAlertOverrides.muteUntilSuccess, true)
            )
          )
        )
        .orderBy(workflows.name),
    ]);

  const recipientsAreDefault = policy.recipientUserIds === null;
  const recipientUserIds =
    policy.recipientUserIds ??
    members.filter((m) => m.role === "owner").map((m) => m.userId);

  return {
    enabled: isFailureAlertsEnabledForOrg(organizationId),
    isDefault: policy.isDefault,
    threshold: policy.threshold,
    timeLimitMinutes: policy.timeLimitMinutes,
    remindDaily: policy.remindDaily,
    notifyRecovery: policy.notifyRecovery,
    recipientUserIds,
    recipientsAreDefault,
    members: members.map(toMemberView),
    channels,
    connections,
    emailUsage,
    customWorkflows: custom,
    unreachable: !isReachable(
      resolveRecipientEmails(policy.recipientUserIds, members),
      channels
    ),
  };
}

export class SettingsError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type ChannelInput = {
  id?: string;
  kind: FailureAlertChannelKind;
  integrationId: string;
  destination: string;
  role: FailureAlertChannelRole;
};

export function parseThreshold(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (
    !Number.isInteger(value) ||
    value < MIN_THRESHOLD ||
    value > MAX_THRESHOLD
  ) {
    throw new SettingsError(
      `Failed runs in a row must be a whole number from ${MIN_THRESHOLD} to ${MAX_THRESHOLD}.`
    );
  }
  return value;
}

export function parseTimeLimit(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === 0) {
    return null;
  }
  const value = Number(raw);
  if (!(TIME_LIMIT_OPTIONS_MINUTES as readonly number[]).includes(value)) {
    throw new SettingsError("Pick a time limit of 1, 6 or 24 hours, or off.");
  }
  return value;
}

/** Validate channel rows against the org's shared connections. */
export async function parseChannels(
  raw: unknown,
  organizationId: string
): Promise<ChannelInput[]> {
  if (!Array.isArray(raw)) {
    return [];
  }
  const connections = new Map(
    (await loadUsableConnections(organizationId)).map((c) => [c.id, c])
  );
  const parsed: ChannelInput[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    const integrationId = String(item?.integrationId ?? "");
    const connection = connections.get(integrationId);
    if (!connection) {
      throw new SettingsError(
        "Pick a connection that is shared with the whole organization."
      );
    }
    const destination = String(item?.destination ?? "").trim();
    if (connection.kind === "slack" && !destination) {
      throw new SettingsError(
        "A Slack channel needs a channel, for example #alerts."
      );
    }
    if (connection.kind === "telegram" && !destination) {
      throw new SettingsError("A Telegram channel needs a chat ID.");
    }
    if (connection.kind === "pagerduty" && !isPagerDutyId(destination)) {
      throw new SettingsError("Pick the PagerDuty service to page.");
    }
    parsed.push({
      id: typeof item?.id === "string" ? item.id : undefined,
      kind: connection.kind,
      integrationId,
      destination: connection.kind === "discord" ? "" : destination,
      role: item?.role === "backup" ? "backup" : "always",
    });
  }
  return parsed;
}

/**
 * Replace a channel list (org-wide when workflowId is null). Rows that are
 * kept keep their id, so their health and history stay attached.
 */
export async function replaceChannels(
  organizationId: string,
  workflowId: string | null,
  channels: ChannelInput[],
  userId: string
): Promise<void> {
  const scope = and(
    eq(failureAlertChannels.organizationId, organizationId),
    workflowId === null
      ? isNull(failureAlertChannels.workflowId)
      : eq(failureAlertChannels.workflowId, workflowId)
  );
  const existing = await db
    .select({
      id: failureAlertChannels.id,
      integrationId: failureAlertChannels.integrationId,
      destination: failureAlertChannels.destination,
    })
    .from(failureAlertChannels)
    .where(scope);
  const existingIds = new Set(existing.map((row) => row.id));
  const keep = new Set<string>();

  for (const channel of channels) {
    const current =
      channel.id && existingIds.has(channel.id)
        ? existing.find((row) => row.id === channel.id)
        : undefined;
    if (current) {
      keep.add(current.id);
      const retargeted =
        current.integrationId !== channel.integrationId ||
        current.destination !== channel.destination;
      await db
        .update(failureAlertChannels)
        .set({
          kind: channel.kind,
          integrationId: channel.integrationId,
          destination: channel.destination,
          role: channel.role,
          // A new destination starts with a clean bill of health.
          ...(retargeted
            ? {
                pausedAt: null,
                pausedReason: null,
                lastError: null,
                lastFailedAt: null,
                lastTestOk: null,
                lastTestedAt: null,
              }
            : {}),
        })
        .where(eq(failureAlertChannels.id, current.id));
      continue;
    }
    await db.insert(failureAlertChannels).values({
      organizationId,
      workflowId,
      kind: channel.kind,
      integrationId: channel.integrationId,
      destination: channel.destination,
      role: channel.role,
      createdBy: userId,
    });
  }

  const removed = [...existingIds].filter((id) => !keep.has(id));
  if (removed.length > 0) {
    await db
      .delete(failureAlertChannels)
      .where(and(scope, inArray(failureAlertChannels.id, removed)));
  }
}

export type OrgSettingsInput = {
  threshold: number;
  timeLimitMinutes: number | null;
  remindDaily: boolean;
  notifyRecovery: boolean;
  recipientUserIds: string[];
  channels: ChannelInput[];
};

export async function parseOrgSettings(
  body: Record<string, unknown>,
  organizationId: string
): Promise<OrgSettingsInput> {
  const members = await loadOrgMembers(organizationId);
  const memberIds = new Set(members.map((m) => m.userId));
  const requested = Array.isArray(body.recipientUserIds)
    ? (body.recipientUserIds as unknown[]).filter(
        (id): id is string => typeof id === "string" && memberIds.has(id)
      )
    : [];
  if (requested.length === 0) {
    throw new SettingsError("Choose at least one person to email.");
  }
  const anyoneReachable = members.some((m) => m.deliverable);
  const chosenReachable = members.some(
    (m) => requested.includes(m.userId) && m.deliverable
  );
  if (anyoneReachable && !chosenReachable) {
    throw new SettingsError(
      "None of the people you chose can receive email yet. Choose someone with a verified email."
    );
  }
  return {
    threshold: parseThreshold(body.threshold),
    timeLimitMinutes: parseTimeLimit(body.timeLimitMinutes),
    remindDaily: body.remindDaily !== false,
    notifyRecovery: body.notifyRecovery !== false,
    recipientUserIds: [...new Set(requested)],
    channels: await parseChannels(body.channels, organizationId),
  };
}

export async function saveOrgSettings(
  organizationId: string,
  input: OrgSettingsInput,
  userId: string
): Promise<void> {
  const owners = (await loadOrgMembers(organizationId))
    .filter((m) => m.role === "owner")
    .map((m) => m.userId)
    .sort();
  // Storing exactly the owners as "the owners" keeps following a transfer.
  const chosen = [...input.recipientUserIds].sort();
  const recipientUserIds =
    chosen.length === owners.length && chosen.every((id, i) => id === owners[i])
      ? null
      : input.recipientUserIds;

  const now = new Date();
  const values = {
    threshold: input.threshold,
    timeLimitMinutes: input.timeLimitMinutes,
    remindDaily: input.remindDaily,
    notifyRecovery: input.notifyRecovery,
    recipientUserIds,
    updatedBy: userId,
    updatedAt: now,
  };
  await db
    .insert(orgFailureAlertSettings)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({
      target: orgFailureAlertSettings.organizationId,
      set: values,
    });
  await replaceChannels(organizationId, null, input.channels, userId);
}

export type HistoryFilter = {
  channel?: string;
  workflowId?: string;
  before?: Date;
  limit?: number;
};

/**
 * What was sent, newest first: every alert, reminder, recovery, backup and
 * notice, with where it went and what happened.
 */
export async function loadHistory(
  organizationId: string,
  filter: HistoryFilter
): Promise<HistoryEntry[]> {
  const limit = Math.min(Math.max(filter.limit ?? HISTORY_PAGE_SIZE, 1), 500);
  const conditions = [
    eq(failureAlertDeliveries.organizationId, organizationId),
  ];
  if (filter.channel) {
    conditions.push(
      eq(
        failureAlertDeliveries.channel,
        filter.channel as typeof failureAlertDeliveries.$inferSelect.channel
      )
    );
  }
  if (filter.before) {
    conditions.push(lt(failureAlertDeliveries.createdAt, filter.before));
  }
  if (filter.workflowId) {
    const incidentIds = db
      .select({ id: workflowFailureIncidents.id })
      .from(workflowFailureIncidents)
      .where(eq(workflowFailureIncidents.workflowId, filter.workflowId));
    conditions.push(inArray(failureAlertDeliveries.incidentId, incidentIds));
  }

  const rows = await db
    .select({
      delivery: failureAlertDeliveries,
      connectionName: integrations.name,
      workflowId: workflowFailureIncidents.workflowId,
      workflowName: workflows.name,
    })
    .from(failureAlertDeliveries)
    .leftJoin(
      failureAlertChannels,
      eq(failureAlertChannels.id, failureAlertDeliveries.channelId)
    )
    .leftJoin(
      integrations,
      eq(integrations.id, failureAlertChannels.integrationId)
    )
    .leftJoin(
      workflowFailureIncidents,
      eq(workflowFailureIncidents.id, failureAlertDeliveries.incidentId)
    )
    .leftJoin(workflows, eq(workflows.id, workflowFailureIncidents.workflowId))
    .where(and(...conditions))
    .orderBy(desc(failureAlertDeliveries.createdAt))
    .limit(limit);

  const groupedIds = new Set<string>();
  for (const { delivery } of rows) {
    const ids = delivery.context?.incidentIds;
    if (Array.isArray(ids)) {
      for (const id of ids) {
        groupedIds.add(String(id));
      }
    }
  }
  const groupedNames = new Map<string, { id: string; name: string }>();
  if (groupedIds.size > 0) {
    const named = await db
      .select({
        incidentId: workflowFailureIncidents.id,
        id: workflows.id,
        name: workflows.name,
      })
      .from(workflowFailureIncidents)
      .innerJoin(
        workflows,
        eq(workflows.id, workflowFailureIncidents.workflowId)
      )
      .where(inArray(workflowFailureIncidents.id, [...groupedIds]));
    for (const row of named) {
      groupedNames.set(row.incidentId, { id: row.id, name: row.name });
    }
  }

  return rows.map(({ delivery, connectionName, workflowId, workflowName }) => {
    const grouped = Array.isArray(delivery.context?.incidentIds)
      ? (delivery.context.incidentIds as string[])
          .map((id) => groupedNames.get(id))
          .filter((w): w is { id: string; name: string } => Boolean(w))
      : [];
    return {
      id: delivery.id,
      createdAt: delivery.createdAt.toISOString(),
      deliveredAt: iso(delivery.deliveredAt),
      kind: delivery.kind,
      channel: delivery.channel,
      recipient: delivery.recipient,
      connectionName,
      isBackup: delivery.isBackup,
      state: delivery.state,
      attempts: delivery.attempts,
      lastStatus: delivery.lastStatus,
      lastError: delivery.lastError,
      note: historyNote(delivery.context),
      workflows:
        workflowId && workflowName
          ? [{ id: workflowId, name: workflowName }]
          : grouped,
    };
  });
}

function historyNote(context: Record<string, unknown> | null): string | null {
  if (typeof context?.channelLabel === "string") {
    return context.channelLabel;
  }
  if (typeof context?.backupReason === "string") {
    return `Sent because ${context.backupReason}`;
  }
  return null;
}

const CSV_HEADER = [
  "time_utc",
  "type",
  "channel",
  "recipient",
  "backup",
  "result",
  "attempts",
  "http_status",
  "error",
  "note",
  "workflows",
];

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\n]/;

function csvCell(value: string | number | boolean | null): string {
  let text = value === null ? "" : String(value);
  // Workflow names and errors are user-controlled; a leading = or + would run
  // as a formula when the export is opened in a spreadsheet.
  if (typeof value === "string" && FORMULA_START.test(text)) {
    text = `'${text}`;
  }
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function historyToCsv(entries: HistoryEntry[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const e of entries) {
    lines.push(
      [
        e.createdAt,
        e.kind,
        e.channel,
        e.recipient,
        e.isBackup,
        e.state,
        e.attempts,
        e.lastStatus,
        e.lastError,
        e.note,
        e.workflows.map((w) => w.name).join("; "),
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Look at workflows again after a settings change, so a lower threshold or an
 * ended mute takes effect now rather than on the next run.
 */
export async function requeueForEvaluation(
  organizationId: string,
  workflowId?: string
): Promise<void> {
  await db.execute(sql`
    INSERT INTO ${workflowFailureAlertQueue} (workflow_id, due_at)
    SELECT id, now() FROM ${workflows}
    WHERE organization_id = ${organizationId}
      AND enabled = true
      AND deleted_at IS NULL
      ${workflowId ? sql`AND id = ${workflowId}` : sql``}
    ON CONFLICT (workflow_id) DO UPDATE SET due_at = now()
  `);
}

export type InAppAlertState = {
  /** Workflows with an open failure incident. */
  failingWorkflows: number;
  /** Nobody can be emailed and no working chat or PagerDuty channel exists. */
  unreachable: boolean;
};

/** What the bell and the top banner show about failure notifications. */
export async function loadInAppAlertState(
  organizationId: string
): Promise<InAppAlertState> {
  if (!isFailureAlertsEnabledForOrg(organizationId)) {
    return { failingWorkflows: 0, unreachable: false };
  }
  const [policy, members, channels, open] = await Promise.all([
    loadOrgPolicy(organizationId),
    loadOrgMembers(organizationId),
    db
      .select({ pausedAt: failureAlertChannels.pausedAt })
      .from(failureAlertChannels)
      .where(
        and(
          eq(failureAlertChannels.organizationId, organizationId),
          isNull(failureAlertChannels.workflowId)
        )
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowFailureIncidents)
      .where(
        and(
          eq(workflowFailureIncidents.organizationId, organizationId),
          isNull(workflowFailureIncidents.resolvedAt)
        )
      ),
  ]);
  return {
    failingWorkflows: open[0]?.count ?? 0,
    unreachable: !isReachable(
      resolveRecipientEmails(policy.recipientUserIds, members),
      channels
    ),
  };
}
