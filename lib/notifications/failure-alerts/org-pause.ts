import "server-only";

import { and, count, eq, isNull, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  failureAlertDeliveries,
  orgFailureAlertSettings,
  workflowFailureAlertOverrides,
  workflows,
} from "@/lib/db/schema";
import type { FailureAlertDeliveryChannel as DeliveryChannel } from "@/lib/db/schema-failure-alerts";
import { loadOrgMembers } from "@/lib/notifications/org-recipients";
import {
  BACKUP_AFTER_MS,
  MAX_ORG_PAUSE_MS,
  MAX_PAUSE_REASON,
} from "./constants";
import {
  ensureOrgSettings,
  loadChannels,
  loadOrgPolicy,
  resolveRecipientEmails,
} from "./policy";
import { buildMessageRows, insertDeliveries, type Tx } from "./queue-rows";
import {
  lockOrgSettings,
  requeueForEvaluation,
  SettingsError,
} from "./settings";

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

/** Held messages (due when the pause ends) move to the new end; backups wait their usual time after it. */
async function moveHeldRows(
  tx: Tx,
  organizationId: string,
  heldUntil: Date,
  to: Date
): Promise<void> {
  for (const [channel, wait] of Object.entries(BACKUP_AFTER_MS)) {
    await tx
      .update(failureAlertDeliveries)
      .set({ nextAttemptAt: to, backupAt: new Date(to.getTime() + wait) })
      .where(
        and(
          eq(failureAlertDeliveries.organizationId, organizationId),
          eq(failureAlertDeliveries.state, "pending"),
          eq(failureAlertDeliveries.channel, channel as DeliveryChannel),
          eq(failureAlertDeliveries.nextAttemptAt, heldUntil)
        )
      );
  }
  // "Nobody reachable" rows are failed from the start; their backups go when the hold ends.
  await tx
    .update(failureAlertDeliveries)
    .set({ nextAttemptAt: to, backupAt: to })
    .where(
      and(
        eq(failureAlertDeliveries.organizationId, organizationId),
        eq(failureAlertDeliveries.state, "failed"),
        eq(failureAlertDeliveries.nextAttemptAt, heldUntil)
      )
    );
}

async function lockedPause(
  tx: Tx,
  organizationId: string
): Promise<{ pausedUntil: Date | null; pausedAt: Date | null } | undefined> {
  await lockOrgSettings(tx, organizationId);
  const [row] = await tx
    .select({
      pausedUntil: orgFailureAlertSettings.pausedUntil,
      pausedAt: orgFailureAlertSettings.pausedAt,
    })
    .from(orgFailureAlertSettings)
    .where(eq(orgFailureAlertSettings.organizationId, organizationId));
  return row;
}

/** Live workflows set to turn off at their limit: they still do during a pause. */
async function countPausingWorkflows(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(workflowFailureAlertOverrides)
    .innerJoin(
      workflows,
      eq(workflows.id, workflowFailureAlertOverrides.workflowId)
    )
    .where(
      and(
        eq(workflowFailureAlertOverrides.organizationId, organizationId),
        eq(workflowFailureAlertOverrides.pauseWorkflow, true),
        eq(workflows.enabled, true),
        isNull(workflows.deletedAt)
      )
    );
  return row?.count ?? 0;
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
  const reason =
    typeof params.reason === "string" && params.reason.trim()
      ? params.reason.trim().slice(0, MAX_PAUSE_REASON)
      : null;
  await ensureOrgSettings(organizationId, now);
  await db.transaction(async (tx: Tx) => {
    const current = await lockedPause(tx, organizationId);
    const ongoing = activePause(current?.pausedUntil ?? null, now);
    // Changing an ongoing pause keeps its start, so extending cannot pass 7 days in all.
    const startedAt = (ongoing && current?.pausedAt) || now;
    const latest = new Date(startedAt.getTime() + MAX_ORG_PAUSE_MS);
    if (until > latest) {
      throw new SettingsError(
        ongoing
          ? `A pause can last up to 7 days in all, so this one can run until ${latest.toUTCString()} at most.`
          : "Alerts can be paused for up to 7 days."
      );
    }
    await tx
      .update(orgFailureAlertSettings)
      .set({
        pausedUntil: until,
        pausedAt: startedAt,
        pauseReason: reason,
        pausedBy: params.byEmail,
        updatedAt: now,
      })
      .where(eq(orgFailureAlertSettings.organizationId, organizationId));
    if (ongoing) {
      await moveHeldRows(tx, organizationId, ongoing, until);
    }
  });
  await queuePauseNotice(
    organizationId,
    "alerts_paused",
    {
      until: until.toISOString(),
      reason,
      by: params.byEmail,
      pausingWorkflows: await countPausingWorkflows(organizationId),
    },
    now
  );
}

/** End a pause now (Resume) or because it ran out; tells people once. */
export async function resumeOrgAlerts(params: {
  organizationId: string;
  byEmail: string | null;
  now: Date;
  /** Only end it if it has run out, so a pause extended meanwhile survives. */
  expiredOnly?: boolean;
}): Promise<boolean> {
  const { organizationId, now } = params;
  const ended = await db.transaction(async (tx: Tx) => {
    const pausedUntil = (await lockedPause(tx, organizationId))?.pausedUntil;
    if (!pausedUntil || (params.expiredOnly && pausedUntil > now)) {
      return false;
    }
    await tx
      .update(orgFailureAlertSettings)
      .set({
        pausedUntil: null,
        pausedAt: null,
        pauseReason: null,
        pausedBy: null,
      })
      .where(eq(orgFailureAlertSettings.organizationId, organizationId));
    // Messages held for an early-ended pause go out now.
    if (pausedUntil > now) {
      await moveHeldRows(tx, organizationId, pausedUntil, now);
    }
    return true;
  });
  if (!ended) {
    return false;
  }
  await queuePauseNotice(
    organizationId,
    "alerts_resumed",
    { by: params.byEmail },
    now
  );
  // Anything still failing is re-checked.
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
    if (
      await resumeOrgAlerts({
        organizationId,
        byEmail: null,
        now,
        expiredOnly: true,
      })
    ) {
      ended += 1;
    }
  }
  return ended;
}
