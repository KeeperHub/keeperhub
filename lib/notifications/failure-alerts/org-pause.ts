import "server-only";

import { and, eq, isNotNull, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { orgFailureAlertSettings } from "@/lib/db/schema";
import { loadOrgMembers } from "@/lib/notifications/org-recipients";
import { MAX_ORG_PAUSE_MS, MAX_PAUSE_REASON } from "./constants";
import {
  ensureOrgSettings,
  loadChannels,
  loadOrgPolicy,
  resolveRecipientEmails,
} from "./policy";
import { buildMessageRows, insertDeliveries } from "./queue-rows";
import { requeueForEvaluation, SettingsError } from "./settings";

/** The org-wide pause is on until this time, or null. */
export function activePause(pausedUntil: Date | null, now: Date): Date | null {
  return pausedUntil && pausedUntil > now ? pausedUntil : null;
}

/** Tell the org's email recipients and chat channels (never PagerDuty) about a pause. */
async function queuePauseNotice(
  organizationId: string,
  kind: "alerts_paused" | "alerts_resumed",
  context: Record<string, unknown>,
  now: Date
): Promise<void> {
  const [org, members, channels] = await Promise.all([
    loadOrgPolicy(organizationId),
    loadOrgMembers(organizationId),
    loadChannels(organizationId, null),
  ]);
  await insertDeliveries(
    buildMessageRows({
      scope: `${kind}:${organizationId}:${now.toISOString()}`,
      organizationId,
      incidentId: null,
      kind,
      sequence: 0,
      emails: resolveRecipientEmails(org.recipientUserIds, members),
      channels,
      includePagerDuty: false,
      context,
      now,
    })
  );
}

export async function pauseOrgAlerts(params: {
  organizationId: string;
  until: unknown;
  reason: unknown;
  byEmail: string | null;
  now: Date;
}): Promise<void> {
  const { organizationId, now } = params;
  const until =
    typeof params.until === "string" ? new Date(params.until) : null;
  if (!until || Number.isNaN(until.getTime()) || until <= now) {
    throw new SettingsError("Pick when alerts should start again.");
  }
  if (until.getTime() - now.getTime() > MAX_ORG_PAUSE_MS) {
    throw new SettingsError("Alerts can be paused for up to 7 days.");
  }
  const reason =
    typeof params.reason === "string" && params.reason.trim()
      ? params.reason.trim().slice(0, MAX_PAUSE_REASON)
      : null;
  await ensureOrgSettings(organizationId, now);
  await db
    .update(orgFailureAlertSettings)
    .set({
      pausedUntil: until,
      pauseReason: reason,
      pausedBy: params.byEmail,
      updatedAt: now,
    })
    .where(eq(orgFailureAlertSettings.organizationId, organizationId));
  await queuePauseNotice(
    organizationId,
    "alerts_paused",
    { until: until.toISOString(), reason, by: params.byEmail },
    now
  );
}

/** End a pause now (Resume) or because it ran out; tells people once. */
export async function resumeOrgAlerts(params: {
  organizationId: string;
  byEmail: string | null;
  now: Date;
}): Promise<boolean> {
  const { organizationId, now } = params;
  const cleared = await db
    .update(orgFailureAlertSettings)
    .set({ pausedUntil: null, pauseReason: null, pausedBy: null })
    .where(
      and(
        eq(orgFailureAlertSettings.organizationId, organizationId),
        isNotNull(orgFailureAlertSettings.pausedUntil)
      )
    )
    .returning({ organizationId: orgFailureAlertSettings.organizationId });
  if (cleared.length === 0) {
    return false;
  }
  await queuePauseNotice(
    organizationId,
    "alerts_resumed",
    { by: params.byEmail },
    now
  );
  // Anything that failed during the pause is reported now.
  await requeueForEvaluation(organizationId);
  return true;
}

/** Pauses whose time is up end in the cycle, so alerts come back on their own. */
export async function endExpiredOrgPauses(now: Date): Promise<number> {
  const expired = await db
    .select({ organizationId: orgFailureAlertSettings.organizationId })
    .from(orgFailureAlertSettings)
    .where(lte(orgFailureAlertSettings.pausedUntil, now));
  let ended = 0;
  for (const { organizationId } of expired) {
    if (await resumeOrgAlerts({ organizationId, byEmail: null, now })) {
      ended += 1;
    }
  }
  return ended;
}
