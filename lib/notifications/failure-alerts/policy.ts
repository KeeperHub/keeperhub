import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  failureAlertChannels,
  orgFailureAlertSettings,
  workflowFailureAlertOverrides,
} from "@/lib/db/schema";
import type {
  FailureAlertChannelKind,
  FailureAlertChannelRole,
} from "@/lib/db/schema-failure-alerts";
import {
  type OrgMember,
  reachableEmails,
} from "@/lib/notifications/org-recipients";
import { DEFAULT_THRESHOLD } from "./constants";

/** The org-wide rule, as stored or as the default when no row exists. */
type OrgPolicy = {
  threshold: number;
  timeLimitMinutes: number | null;
  remindDaily: boolean;
  notifyRecovery: boolean;
  /** Null: the organization's owners. */
  recipientUserIds: string[] | null;
  countingSince: Date | null;
  /** Org-wide pause (maintenance); alerts stay off until then. */
  pausedUntil: Date | null;
  pauseReason: string | null;
  pausedBy: string | null;
  isDefault: boolean;
};

export const DEFAULT_ORG_POLICY: OrgPolicy = {
  threshold: DEFAULT_THRESHOLD,
  timeLimitMinutes: null,
  remindDaily: true,
  notifyRecovery: true,
  recipientUserIds: null,
  countingSince: null,
  pausedUntil: null,
  pauseReason: null,
  pausedBy: null,
  isDefault: true,
};

export type ChannelConfig = {
  id: string;
  kind: FailureAlertChannelKind;
  integrationId: string;
  destination: string;
  role: FailureAlertChannelRole;
  pausedAt: Date | null;
};

type WorkflowOverride = typeof workflowFailureAlertOverrides.$inferSelect;

/** What applies to one workflow once its override is laid over the org rule. */
export type EffectivePolicy = {
  threshold: number;
  timeLimitMinutes: number | null;
  remindDaily: boolean;
  notifyRecovery: boolean;
  recipientUserIds: string[] | null;
  channels: ChannelConfig[];
  mutedUntil: Date | null;
  muteUntilSuccess: boolean;
  /** Turn the workflow off when its alert goes out. Never set org-wide. */
  pauseWorkflow: boolean;
  /** The org-wide pause, if one is set (it may have run out). */
  orgPausedUntil: Date | null;
  countingSince: Date | null;
  source: "default" | "org" | "custom";
};

export async function loadOrgPolicy(
  organizationId: string
): Promise<OrgPolicy> {
  const [row] = await db
    .select()
    .from(orgFailureAlertSettings)
    .where(eq(orgFailureAlertSettings.organizationId, organizationId))
    .limit(1);
  if (!row) {
    return DEFAULT_ORG_POLICY;
  }
  return {
    threshold: row.threshold,
    timeLimitMinutes: row.timeLimitMinutes,
    remindDaily: row.remindDaily,
    notifyRecovery: row.notifyRecovery,
    recipientUserIds: row.recipientUserIds ?? null,
    countingSince: row.countingSince,
    pausedUntil: row.pausedUntil,
    pauseReason: row.pauseReason,
    pausedBy: row.pausedBy,
    isDefault: false,
  };
}

/**
 * The count starts a little before the evaluator first sees the org, so the
 * very run that brought it here (finished a moment before this cycle) counts.
 */
const COUNTING_SLACK_MS = 10 * 60 * 1000;

/** Make sure the org has a settings row and a start for the count. */
export async function ensureOrgSettings(
  organizationId: string,
  now: Date
): Promise<void> {
  const countingSince = new Date(now.getTime() - COUNTING_SLACK_MS);
  const inserted = await db
    .insert(orgFailureAlertSettings)
    .values({ organizationId, countingSince })
    .onConflictDoNothing()
    .returning({ organizationId: orgFailureAlertSettings.organizationId });
  if (inserted.length > 0) {
    return;
  }
  // A row saved from settings before the evaluator ever ran has no start yet.
  await db
    .update(orgFailureAlertSettings)
    .set({ countingSince })
    .where(
      and(
        eq(orgFailureAlertSettings.organizationId, organizationId),
        isNull(orgFailureAlertSettings.countingSince)
      )
    );
}

export async function loadChannels(
  organizationId: string,
  workflowId: string | null
): Promise<ChannelConfig[]> {
  const rows = await db
    .select({
      id: failureAlertChannels.id,
      kind: failureAlertChannels.kind,
      integrationId: failureAlertChannels.integrationId,
      destination: failureAlertChannels.destination,
      role: failureAlertChannels.role,
      pausedAt: failureAlertChannels.pausedAt,
    })
    .from(failureAlertChannels)
    .where(
      and(
        eq(failureAlertChannels.organizationId, organizationId),
        workflowId === null
          ? isNull(failureAlertChannels.workflowId)
          : eq(failureAlertChannels.workflowId, workflowId)
      )
    );
  return rows;
}

export async function loadOverride(
  workflowId: string
): Promise<WorkflowOverride | null> {
  const [row] = await db
    .select()
    .from(workflowFailureAlertOverrides)
    .where(eq(workflowFailureAlertOverrides.workflowId, workflowId))
    .limit(1);
  return row ?? null;
}

/** Lay a workflow override over the org rule. Pure, so it is testable. */
export function mergePolicy(
  org: OrgPolicy,
  orgChannels: ChannelConfig[],
  override: WorkflowOverride | null,
  workflowChannels: ChannelConfig[]
): EffectivePolicy {
  const customised =
    override !== null &&
    (override.threshold !== null ||
      override.timeLimitMinutes !== null ||
      override.recipientUserIds !== null ||
      override.customChannels ||
      override.pauseWorkflow);

  let timeLimitMinutes = org.timeLimitMinutes;
  if (
    override?.timeLimitMinutes !== null &&
    override?.timeLimitMinutes !== undefined
  ) {
    timeLimitMinutes =
      override.timeLimitMinutes === 0 ? null : override.timeLimitMinutes;
  }

  let source: EffectivePolicy["source"] = org.isDefault ? "default" : "org";
  if (customised) {
    source = "custom";
  }

  return {
    threshold: override?.threshold ?? org.threshold,
    timeLimitMinutes,
    remindDaily: org.remindDaily,
    notifyRecovery: org.notifyRecovery,
    recipientUserIds: override?.recipientUserIds ?? org.recipientUserIds,
    channels: override?.customChannels ? workflowChannels : orgChannels,
    mutedUntil: override?.mutedUntil ?? null,
    muteUntilSuccess: override?.muteUntilSuccess ?? false,
    pauseWorkflow: override?.pauseWorkflow ?? false,
    orgPausedUntil: org.pausedUntil,
    countingSince: org.countingSince,
    source,
  };
}

export async function loadEffectivePolicy(
  organizationId: string,
  workflowId: string
): Promise<EffectivePolicy> {
  const [org, override] = await Promise.all([
    loadOrgPolicy(organizationId),
    loadOverride(workflowId),
  ]);
  const [orgChannels, workflowChannels] = await Promise.all([
    loadChannels(organizationId, null),
    override?.customChannels
      ? loadChannels(organizationId, workflowId)
      : Promise.resolve([]),
  ]);
  return mergePolicy(org, orgChannels, override, workflowChannels);
}

export function isMuted(policy: EffectivePolicy, now: Date): boolean {
  if (policy.muteUntilSuccess) {
    return true;
  }
  return policy.mutedUntil !== null && policy.mutedUntil > now;
}

/**
 * The addresses an alert goes to.
 *
 * Chosen members who left or cannot be reached are dropped. If nobody chosen
 * is reachable, the owners are used, then the admins, so "email always
 * reaches at least one person" holds whenever anyone in the org can be
 * reached at all. An empty result means nobody can, and the alert relies on
 * chat channels and the in-app notice.
 */
export function resolveRecipientEmails(
  recipientUserIds: string[] | null,
  members: OrgMember[]
): string[] {
  if (recipientUserIds !== null) {
    const chosen = new Set(recipientUserIds);
    const emails = reachableEmails(members.filter((m) => chosen.has(m.userId)));
    if (emails.length > 0) {
      return emails;
    }
  }
  const owners = reachableEmails(members.filter((m) => m.role === "owner"));
  if (owners.length > 0) {
    return owners;
  }
  return reachableEmails(members.filter((m) => m.role === "admin"));
}

export async function loadChannelsByIds(
  ids: string[]
): Promise<Map<string, ChannelConfig>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      id: failureAlertChannels.id,
      kind: failureAlertChannels.kind,
      integrationId: failureAlertChannels.integrationId,
      destination: failureAlertChannels.destination,
      role: failureAlertChannels.role,
      pausedAt: failureAlertChannels.pausedAt,
    })
    .from(failureAlertChannels)
    .where(inArray(failureAlertChannels.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}
