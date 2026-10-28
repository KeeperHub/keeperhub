import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  failureAlertChannels,
  member,
  orgFailureAlertSettings,
  users,
  workflowFailureAlertOverrides,
} from "@/lib/db/schema";
import type {
  FailureAlertChannelKind,
  FailureAlertChannelRole,
} from "@/lib/db/schema-failure-alerts";
import { deliverableAddress } from "@/lib/notifications/deliverable-address";
import { DEFAULT_THRESHOLD } from "./constants";

/** The org-wide rule, as stored or as the default when no row exists. */
export type OrgPolicy = {
  threshold: number;
  timeLimitMinutes: number | null;
  remindDaily: boolean;
  notifyRecovery: boolean;
  /** Null: the organization's owners. */
  recipientUserIds: string[] | null;
  countingSince: Date | null;
  isDefault: boolean;
};

export const DEFAULT_ORG_POLICY: OrgPolicy = {
  threshold: DEFAULT_THRESHOLD,
  timeLimitMinutes: null,
  remindDaily: true,
  notifyRecovery: true,
  recipientUserIds: null,
  countingSince: null,
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

export type WorkflowOverride =
  typeof workflowFailureAlertOverrides.$inferSelect;

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
    isDefault: false,
  };
}

/**
 * Make sure the org has a settings row, starting the count now. Returns true
 * when this call created it: the first time the evaluator sees the org with
 * the feature on, which is when the launch notice goes out.
 */
export async function ensureOrgSettings(
  organizationId: string,
  now: Date
): Promise<boolean> {
  const inserted = await db
    .insert(orgFailureAlertSettings)
    .values({ organizationId, countingSince: now })
    .onConflictDoNothing()
    .returning({ organizationId: orgFailureAlertSettings.organizationId });
  if (inserted.length > 0) {
    return true;
  }
  // A row saved from settings before the evaluator ever ran has no start yet.
  await db
    .update(orgFailureAlertSettings)
    .set({ countingSince: now })
    .where(
      and(
        eq(orgFailureAlertSettings.organizationId, organizationId),
        isNull(orgFailureAlertSettings.countingSince)
      )
    );
  return false;
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
      override.customChannels);

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

export type OrgMember = {
  userId: string;
  role: string;
  email: string | null;
  name: string | null;
  /** Where mail actually reaches them, or null (wallet-only, unverified). */
  deliverable: string | null;
};

export async function loadOrgMembers(
  organizationId: string
): Promise<OrgMember[]> {
  const rows = await db
    .select({
      userId: member.userId,
      role: member.role,
      email: users.email,
      emailVerified: users.emailVerified,
      stepUpEmail: users.stepUpEmail,
      name: users.name,
    })
    .from(member)
    .innerJoin(users, eq(users.id, member.userId))
    .where(eq(member.organizationId, organizationId));
  return rows.map((row) => ({
    userId: row.userId,
    role: row.role,
    email: row.email,
    name: row.name,
    deliverable: deliverableAddress(row),
  }));
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
  const reachable = (list: OrgMember[]): string[] => [
    ...new Set(
      list
        .map((m) => m.deliverable)
        .filter((email): email is string => Boolean(email))
    ),
  ];

  if (recipientUserIds !== null) {
    const chosen = new Set(recipientUserIds);
    const emails = reachable(members.filter((m) => chosen.has(m.userId)));
    if (emails.length > 0) {
      return emails;
    }
  }
  const owners = reachable(members.filter((m) => m.role === "owner"));
  if (owners.length > 0) {
    return owners;
  }
  return reachable(members.filter((m) => m.role === "admin"));
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
