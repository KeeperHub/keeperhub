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
import {
  loadOrgMembers,
  type OrgMember,
} from "@/lib/notifications/org-recipients";
import { isPagerDutyId } from "@/plugins/pagerduty/steps/pagerduty-core";
import {
  FREE_PLAN_MONTHLY_EMAILS,
  HISTORY_PAGE_SIZE,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  TIME_LIMIT_OPTIONS_MINUTES,
} from "./constants";
import { loadOrgPolicy, resolveRecipientEmails } from "./policy";
import type { Tx } from "./queue-rows";
import { isFailureAlertsEnabledForOrg } from "./rollout";
import { checkChannelSilently } from "./senders";
import {
  type ChannelView,
  type ConnectionView,
  channelLabel,
  type HistoryEntry,
  historyNote,
  type MemberView,
  type OrgSettingsView,
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
  const usable = new Set(
    (await loadUsableConnections(organizationId)).map((c) => c.id)
  );
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
    lastHealthCheckAt: iso(channel.lastHealthCheckAt),
    connectionMissing: !usable.has(channel.integrationId),
  }));
}

/** Org-shared connections, or with `ownerId` that user's unshared ones (to explain them). */
export async function loadUsableConnections(
  organizationId: string,
  ownerId?: string
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
        ownerId
          ? and(
              eq(integrations.createdBy, ownerId),
              sql`${integrations.visibility} <> 'organization'`
            )
          : eq(integrations.visibility, "organization"),
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

async function loadFailingNow(
  organizationId: string
): Promise<OrgSettingsView["failingNow"]> {
  const rows = await db
    .select({
      workflowId: workflowFailureIncidents.workflowId,
      name: workflows.name,
      failureCount: workflowFailureIncidents.failureCount,
      openedAt: workflowFailureIncidents.openedAt,
      openedBy: workflowFailureIncidents.openedBy,
      dueAt: workflowFailureIncidents.firstFailedAt,
    })
    .from(workflowFailureIncidents)
    .innerJoin(workflows, eq(workflows.id, workflowFailureIncidents.workflowId))
    .where(
      and(
        eq(workflowFailureIncidents.organizationId, organizationId),
        isNull(workflowFailureIncidents.resolvedAt)
      )
    )
    .orderBy(desc(workflowFailureIncidents.openedAt))
    .limit(50);
  return rows.map((row) => ({
    ...row,
    openedAt: row.openedAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
  }));
}

async function lastAlertDelivered(
  organizationId: string
): Promise<string | null> {
  const [row] = await db
    .select({
      at: sql`max(${failureAlertDeliveries.deliveredAt})`.mapWith(
        failureAlertDeliveries.deliveredAt
      ),
    })
    .from(failureAlertDeliveries)
    .where(
      and(
        eq(failureAlertDeliveries.organizationId, organizationId),
        eq(failureAlertDeliveries.state, "delivered"),
        inArray(failureAlertDeliveries.kind, ["alert", "reminder", "recovery"])
      )
    );
  return row?.at ? row.at.toISOString() : null;
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

/** Someone can be told: an email that is not capped, or a method that works. */
export function isReachable(
  emails: string[],
  channels: { pausedAt: string | Date | null; connectionMissing?: boolean }[],
  emailCapped = false
): boolean {
  return (
    (emails.length > 0 && !emailCapped) ||
    channels.some((c) => !(c.pausedAt || c.connectionMissing))
  );
}

function capReached(usage: { used: number; limit: number } | null): boolean {
  return usage !== null && usage.used >= usage.limit;
}

export async function loadOrgSettingsView(
  organizationId: string,
  viewerUserId: string
): Promise<OrgSettingsView> {
  const [
    policy,
    members,
    channels,
    connections,
    unsharedConnections,
    emailUsage,
    failingNow,
    custom,
  ] = await Promise.all([
    loadOrgPolicy(organizationId),
    loadOrgMembers(organizationId),
    loadChannelViews(organizationId, null),
    loadUsableConnections(organizationId),
    loadUsableConnections(organizationId, viewerUserId),
    loadEmailUsage(organizationId),
    loadFailingNow(organizationId),
    db
      .select({
        id: workflows.id,
        name: workflows.name,
        mutedUntil: workflowFailureAlertOverrides.mutedUntil,
        muteUntilSuccess: workflowFailureAlertOverrides.muteUntilSuccess,
        threshold: workflowFailureAlertOverrides.threshold,
        recipientUserIds: workflowFailureAlertOverrides.recipientUserIds,
        customChannels: workflowFailureAlertOverrides.customChannels,
        pauseWorkflow: workflowFailureAlertOverrides.pauseWorkflow,
      })
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
            eq(workflowFailureAlertOverrides.muteUntilSuccess, true),
            eq(workflowFailureAlertOverrides.pauseWorkflow, true)
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
    unsharedConnections,
    emailUsage,
    customWorkflows: custom.map((row) => ({
      id: row.id,
      name: row.name,
      mutedUntil:
        row.mutedUntil && row.mutedUntil > new Date()
          ? row.mutedUntil.toISOString()
          : null,
      muteUntilSuccess: row.muteUntilSuccess,
      threshold: row.threshold,
      customRecipients: row.recipientUserIds !== null,
      customChannels: row.customChannels,
      pauseWorkflow: row.pauseWorkflow,
    })),
    lastAlertDeliveredAt: await lastAlertDelivered(organizationId),
    version: policy.version,
    pause:
      policy.pausedUntil && policy.pausedUntil > new Date()
        ? {
            until: policy.pausedUntil.toISOString(),
            reason: policy.pauseReason,
            by: policy.pausedBy,
          }
        : null,
    failingNow,
    unreachable: !isReachable(
      resolveRecipientEmails(policy.recipientUserIds, members),
      channels,
      capReached(emailUsage)
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

type ChannelInput = {
  id?: string;
  kind: FailureAlertChannelKind;
  integrationId: string;
  destination: string;
  role: FailureAlertChannelRole;
  /** Undo of a deleted channel restores it paused; can pause, never unpause. */
  pausedReason?: string;
};

const MAX_PAUSED_REASON = 500;
const TELEGRAM_CHAT_ID = /^(-?\d{5,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const TRAILING_PERIOD = /\.+$/;

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

/** Validate channels; with verify, new or retargeted ones must pass a silent check. */
export async function parseChannels(
  raw: unknown,
  organizationId: string,
  options: { verify?: boolean } = {}
): Promise<ChannelInput[]> {
  if (!Array.isArray(raw)) {
    return [];
  }
  const items = raw as Record<string, unknown>[];
  const connections = new Map(
    (await loadUsableConnections(organizationId)).map((c) => [c.id, c])
  );
  const savedIds = items.flatMap((item) =>
    typeof item?.id === "string" ? [item.id] : []
  );
  const saved =
    savedIds.length > 0
      ? await db
          .select({
            id: failureAlertChannels.id,
            kind: failureAlertChannels.kind,
            integrationId: failureAlertChannels.integrationId,
            destination: failureAlertChannels.destination,
          })
          .from(failureAlertChannels)
          .where(
            and(
              eq(failureAlertChannels.organizationId, organizationId),
              inArray(failureAlertChannels.id, savedIds)
            )
          )
      : [];
  const parsed: ChannelInput[] = [];
  for (const item of items) {
    const integrationId = String(item?.integrationId ?? "");
    const connection = connections.get(integrationId);
    // Keep a channel whose connection vanished, so it does not block other
    // changes; the sender pauses it.
    const unchanged = connection
      ? undefined
      : saved.find(
          (row) =>
            row.id === item?.id &&
            row.integrationId === integrationId &&
            row.destination === String(item?.destination ?? "").trim()
        );
    if (unchanged) {
      parsed.push({
        id: unchanged.id,
        kind: unchanged.kind,
        integrationId,
        destination: unchanged.destination,
        role: item?.role === "backup" ? "backup" : "always",
      });
      continue;
    }
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
    if (connection.kind === "telegram" && !TELEGRAM_CHAT_ID.test(destination)) {
      throw new SettingsError(
        "That is not a Telegram chat ID: use a number like -1001234567890, or @name for a public channel."
      );
    }
    if (connection.kind === "pagerduty" && !isPagerDutyId(destination)) {
      throw new SettingsError("Pick the PagerDuty service to page.");
    }
    const target = connection.kind === "discord" ? "" : destination;
    // The same connection and destination twice would send every alert twice.
    if (
      parsed.some(
        (p) => p.integrationId === integrationId && p.destination === target
      )
    ) {
      throw new SettingsError(
        `${connection.name} is already in the list${target ? ` for ${target}` : ""}.`
      );
    }
    parsed.push({
      id: typeof item?.id === "string" ? item.id : undefined,
      kind: connection.kind,
      integrationId,
      destination: target,
      role: item?.role === "backup" ? "backup" : "always",
      pausedReason:
        typeof item?.pausedReason === "string" && item.pausedReason.trim()
          ? item.pausedReason.trim().slice(0, MAX_PAUSED_REASON)
          : undefined,
    });
  }
  if (options.verify) {
    await verifyNewTargets(parsed, saved, connections, organizationId);
  }
  return parsed;
}

/** Refuse a new or changed target that cannot receive notifications. */
async function verifyNewTargets(
  parsed: ChannelInput[],
  saved: { id: string; integrationId: string; destination: string }[],
  connections: Map<string, ConnectionView>,
  organizationId: string
): Promise<void> {
  // A paused channel put back by Undo is restored as it was, paused.
  const fresh = parsed.filter(
    (p) =>
      !(
        (p.pausedReason && !p.id) ||
        saved.some(
          (row) =>
            row.id === p.id &&
            row.integrationId === p.integrationId &&
            row.destination === p.destination
        )
      )
  );
  const results = await Promise.all(
    fresh.map(async (channel) => ({
      channel,
      outcome: await checkChannelSilently(
        { ...channel, id: channel.id ?? "new", pausedAt: null },
        organizationId
      ),
    }))
  );
  const failed = results.find((r) => !r.outcome.ok);
  if (!failed) {
    return;
  }
  const { channel, outcome } = failed;
  const label = channelLabel(
    channel.kind,
    channel.destination,
    connections.get(channel.integrationId)?.name
  );
  const reason = outcome.message.replace(TRAILING_PERIOD, "");
  throw new SettingsError(
    outcome.retryable
      ? `${label} could not be checked right now (${reason}). Try saving again in a minute.`
      : `${label} cannot receive notifications: ${reason}. Fix it, then save.`
  );
}

/** Replace a channel list; kept rows keep their id, health and history. */
export async function replaceChannels(
  tx: Tx,
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
  const existing = await tx
    .select({
      id: failureAlertChannels.id,
      integrationId: failureAlertChannels.integrationId,
      destination: failureAlertChannels.destination,
    })
    .from(failureAlertChannels)
    .where(scope);
  const existingIds = new Set(existing.map((row) => row.id));
  // Ids the list names are spoken for: adoption below must not take them.
  const named = new Set(
    channels.flatMap((channel) =>
      channel.id && existingIds.has(channel.id) ? [channel.id] : []
    )
  );
  const keep = new Set<string>();
  const matched = channels.map((channel) => {
    // Matched by id, or by connection and destination: a second save that
    // raced the first one's new row adopts it instead of adding a twin.
    const current =
      (channel.id && named.has(channel.id)
        ? existing.find((row) => row.id === channel.id)
        : undefined) ??
      existing.find(
        (row) =>
          !(keep.has(row.id) || named.has(row.id)) &&
          row.integrationId === channel.integrationId &&
          row.destination === channel.destination
      );
    if (current) {
      keep.add(current.id);
    }
    return { channel, current };
  });

  // Removals first, so a kept row may move onto a destination a removed row
  // held without tripping the unique index.
  const removed = [...existingIds].filter((id) => !keep.has(id));
  if (removed.length > 0) {
    await tx
      .delete(failureAlertChannels)
      .where(and(scope, inArray(failureAlertChannels.id, removed)));
  }

  for (const { channel, current } of matched) {
    if (current) {
      const retargeted =
        current.integrationId !== channel.integrationId ||
        current.destination !== channel.destination;
      await tx
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
    await tx.insert(failureAlertChannels).values({
      organizationId,
      workflowId,
      kind: channel.kind,
      integrationId: channel.integrationId,
      destination: channel.destination,
      role: channel.role,
      createdBy: userId,
      // Saving ran the silent check, so a new method starts checked.
      ...(channel.pausedReason
        ? { pausedAt: new Date(), pausedReason: channel.pausedReason }
        : { lastHealthCheckAt: new Date() }),
    });
  }
}

type OrgSettingsInput = {
  threshold: number;
  timeLimitMinutes: number | null;
  remindDaily: boolean;
  notifyRecovery: boolean;
  recipientUserIds: string[];
  channels: ChannelInput[];
  /** The version the editor loaded; absent (API callers) skips the check. */
  version: number | null;
};

const STALE_SAVE =
  "These settings were changed by someone else. Reload to see the latest, then save again.";

/** Refuse a save made from an older copy, so it cannot undo someone else's change. */
export function checkVersion(expected: number | null, current: number): void {
  if (expected !== null && expected !== current) {
    throw new SettingsError(STALE_SAVE, 409);
  }
}

export function parseVersion(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) ? raw : null;
}

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
    channels: await parseChannels(body.channels, organizationId, {
      verify: true,
    }),
    version: parseVersion(body.version),
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
  await db.transaction(async (tx: Tx) => {
    await lockOrgSettings(tx, organizationId);
    const [current] = await tx
      .select({ version: orgFailureAlertSettings.version })
      .from(orgFailureAlertSettings)
      .where(eq(orgFailureAlertSettings.organizationId, organizationId));
    checkVersion(input.version, current?.version ?? 0);
    const next = { ...values, version: (current?.version ?? 0) + 1 };
    await tx
      .insert(orgFailureAlertSettings)
      .values({ organizationId, ...next })
      .onConflictDoUpdate({
        target: orgFailureAlertSettings.organizationId,
        set: next,
      });
    await replaceChannels(tx, organizationId, null, input.channels, userId);
  });
}

/** Serialise one org's saves so overlapping ones never interleave channel changes. */
export async function lockOrgSettings(
  tx: Tx,
  organizationId: string
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`failure-alerts:${organizationId}`}))`
  );
}

type HistoryFilter = {
  channel?: string;
  workflowId?: string;
  before?: Date;
  limit?: number;
};

/** Everything sent, newest first, with destination and outcome. */
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
    // Its own messages, and grouped alerts that listed it.
    conditions.push(sql`EXISTS (
      SELECT 1 FROM ${workflowFailureIncidents} i
      WHERE i.workflow_id = ${filter.workflowId}
        AND i.organization_id = ${organizationId}
        AND (${failureAlertDeliveries.incidentId} = i.id
          OR ${failureAlertDeliveries.context} @> jsonb_build_object('incidentIds', jsonb_build_array(i.id)))
    )`);
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
const NEEDS_QUOTES = /[",\n\r]/;

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

/** Re-evaluate after a settings change so it applies now, not on the next run. */
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

type InAppAlertState = {
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
  const [policy, members, rows, open, usable, usage] = await Promise.all([
    loadOrgPolicy(organizationId),
    loadOrgMembers(organizationId),
    db
      .select({
        pausedAt: failureAlertChannels.pausedAt,
        integrationId: failureAlertChannels.integrationId,
      })
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
    loadUsableConnections(organizationId),
    loadEmailUsage(organizationId),
  ]);
  const usableIds = new Set(usable.map((c) => c.id));
  const channels = rows.map((row) => ({
    pausedAt: row.pausedAt,
    connectionMissing: !usableIds.has(row.integrationId),
  }));
  return {
    failingWorkflows: open[0]?.count ?? 0,
    unreachable: !isReachable(
      resolveRecipientEmails(policy.recipientUserIds, members),
      channels,
      capReached(usage)
    ),
  };
}
