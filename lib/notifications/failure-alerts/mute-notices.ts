import "server-only";

import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, isNull, type SQL, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  organization,
  workflowExecutions,
  workflowFailureAlertOverrides,
  workflowFailureAlertQueue,
  workflowFailureIncidents,
  workflows,
} from "@/lib/db/schema";
import type { Tx } from "@/lib/db/tx";
import {
  loadOrgMembers,
  type OrgMember,
  reachableEmails,
} from "@/lib/notifications/org-recipients";
import { signInAccounts } from "./accounts";
import { REMINDER_INTERVAL_MS } from "./constants";
import { pauseActorName } from "./messages";
import {
  type EffectivePolicy,
  fallbackManagers,
  loadEffectivePolicy,
  resolveRecipientEmails,
} from "./policy";
import { buildMessageRows, insertDeliveries } from "./queue-rows";
import { isFailureAlertsEnabledForOrg } from "./rollout";
import { attemptConditions, REFUSED_RUN_SQL } from "./streak-runs";
import type { OrgSettingsView } from "./view-types";

type Actor = {
  by: string | null;
  byUserId: string | null;
  byAccount: string | null;
};

/** A member's name as notices show it, or null for nobody. */
export function nameOf(
  userId: string | null | undefined,
  members: OrgMember[]
): string | null {
  return userId
    ? pauseActorName(members.find((m) => m.userId === userId))
    : null;
}

/** Who acted, as notices and the By column name them. */
export async function actorOf(
  userId: string | null,
  members: OrgMember[]
): Promise<Actor> {
  if (!userId) {
    return { by: null, byUserId: null, byAccount: null };
  }
  const accounts = await signInAccounts([userId]);
  return {
    by: nameOf(userId, members),
    byUserId: userId,
    byAccount: accounts.get(userId) ?? null,
  };
}

/** Owners who can get email; with none, admins who can, so a notice never reaches only its author. */
function ownerEmails(members: OrgMember[]): string[] {
  return reachableEmails(fallbackManagers(members));
}

/** A mute notice: everyone the workflow's alerts reach under `policy` (before the change) plus every owner. */
export async function queueWorkflowNotice(params: {
  organizationId: string;
  workflow: { id: string; name: string };
  kind: "workflow_muted" | "workflow_unmuted" | "mute_ended";
  policy: EffectivePolicy;
  members: OrgMember[];
  context: Record<string, unknown>;
  now: Date;
  tx?: Tx | typeof db;
}): Promise<void> {
  const { workflow, kind } = params;
  const emails = [
    ...new Set([
      ...resolveRecipientEmails(params.policy.recipientUserIds, params.members),
      ...ownerEmails(params.members),
    ]),
  ];
  await insertDeliveries(
    buildMessageRows({
      // One per notice: two mutes in the same millisecond are two notices.
      scope: `${kind}:${workflow.id}:${randomUUID()}`,
      organizationId: params.organizationId,
      incidentId: null,
      kind,
      sequence: 0,
      emails,
      channels: params.policy.channels,
      includePagerDuty: false,
      context: {
        ...params.context,
        workflowId: workflow.id,
        workflowName: workflow.name,
      },
      now: params.now,
    }),
    params.tx ?? db
  );
}

/** People taken off a recipient list hear it once, by email; owners hear it too. */
export async function queueRemovedNotice(params: {
  organizationId: string;
  workflow: { id: string; name: string } | null;
  removed: OrgMember[];
  actor: Actor;
  members: OrgMember[];
  now: Date;
  tx?: Tx | typeof db;
}): Promise<void> {
  if (params.removed.length === 0) {
    return;
  }
  const emails = [
    ...new Set([
      ...reachableEmails(params.removed),
      ...ownerEmails(params.members),
    ]),
  ];
  if (emails.length === 0) {
    return;
  }
  // Names, never an inbox: the notice goes to more than the people it names.
  const removed = params.removed.map((m) => pauseActorName(m) ?? "A member");
  await insertDeliveries(
    buildMessageRows({
      scope: `recipients_removed:${params.workflow?.id ?? params.organizationId}:${randomUUID()}`,
      organizationId: params.organizationId,
      incidentId: null,
      kind: "recipients_removed",
      sequence: 0,
      emails,
      channels: [],
      includePagerDuty: false,
      context: {
        ...params.actor,
        removed,
        ...(params.workflow
          ? {
              workflowId: params.workflow.id,
              workflowName: params.workflow.name,
            }
          : {}),
      },
      now: params.now,
    }),
    params.tx ?? db
  );
}

/** Runs that failed since `since`, counted as the streak counts them. */
async function failedRunsSince(
  workflowId: string,
  since: Date
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(workflowExecutions)
    .where(
      and(
        attemptConditions(workflowId, since),
        eq(workflowExecutions.status, "error")
      )
    );
  return Number(row?.n ?? 0);
}

/** Whether the newest attempt the streak counts failed or was refused (not running is not working). */
async function latestRunFailed(workflowId: string): Promise<boolean> {
  const [run] = await db
    .select({
      status: workflowExecutions.status,
      refused: sql<boolean>`${REFUSED_RUN_SQL}`,
    })
    .from(workflowExecutions)
    .where(attemptConditions(workflowId, null))
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(1);
  return run?.status === "error" || run?.refused === true;
}

/** Every workflow muted right now, failing ones first, for Needs attention. */
export async function loadMutedWorkflows(
  organizationId: string,
  members: OrgMember[],
  now: Date = new Date()
): Promise<OrgSettingsView["mutedWorkflows"]> {
  const rows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      mutedUntil: workflowFailureAlertOverrides.mutedUntil,
      muteUntilSuccess: workflowFailureAlertOverrides.muteUntilSuccess,
      muteReason: workflowFailureAlertOverrides.muteReason,
      mutedBy: workflowFailureAlertOverrides.mutedBy,
      mutedAt: workflowFailureAlertOverrides.mutedAt,
      updatedAt: workflowFailureAlertOverrides.updatedAt,
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
        gt(workflowFailureAlertOverrides.mutedUntil, now)
      )
    );
  if (rows.length === 0) {
    return [];
  }
  const accounts = await signInAccounts(
    rows.flatMap((r) => (r.mutedBy ? [r.mutedBy] : []))
  );
  const muted = await Promise.all(
    rows.map(async (r) => {
      const since = r.mutedAt ?? r.updatedAt;
      const [failedRuns, failing] = await Promise.all([
        failedRunsSince(r.id, since),
        latestRunFailed(r.id),
      ]);
      return {
        id: r.id,
        name: r.name,
        mutedUntil: r.mutedUntil?.toISOString() ?? null,
        untilItWorks: r.muteUntilSuccess,
        by: nameOf(r.mutedBy, members),
        byAccount: r.mutedBy ? (accounts.get(r.mutedBy) ?? null) : null,
        reason: r.muteReason,
        failing,
        failedRuns,
        since: since.toISOString(),
      };
    })
  );
  return muted.sort(
    (a, b) =>
      Number(b.failing) - Number(a.failing) ||
      (a.mutedUntil ?? "").localeCompare(b.mutedUntil ?? "")
  );
}

type EndedMute = {
  workflowId: string;
  organizationId: string;
  name: string;
  mutedBy: string | null;
  mutedAt: Date | null;
  updatedAt: Date;
  reason: string | null;
  until: Date | null;
  untilItWorks: boolean;
  /** Deleted workflow or deactivated org: the mute is cleared without a notice. */
  gone: boolean;
};

/**
 * Ends the mutes `where` selects, exactly once each: clears them, tells everyone
 * (with the failures they hid) and queues the workflow so a failure alerts now.
 */
async function endMutes(
  where: SQL,
  ended: "expired" | "worked",
  now: Date
): Promise<number> {
  return await db.transaction(async (tx: Tx) => {
    // Times come back as text: a raw timestamp would parse as local time.
    const rows = await tx.execute<{
      workflow_id: string;
      organization_id: string;
      name: string;
      muted_by: string | null;
      muted_at: string | null;
      updated_at: string;
      mute_reason: string | null;
      muted_until: string | null;
      mute_until_success: boolean;
      gone: boolean;
    }>(sql`
      UPDATE ${workflowFailureAlertOverrides} AS o
         SET muted_until = NULL, mute_until_success = false, mute_reason = NULL,
             muted_by = NULL, muted_at = NULL, version = o.version + 1
        FROM (
          SELECT ov.workflow_id, ov.muted_by, ov.muted_at, ov.updated_at,
                 ov.mute_reason, ov.muted_until, ov.mute_until_success, w.name,
                 (w.deleted_at IS NOT NULL OR org.deactivated_at IS NOT NULL) AS gone
            FROM ${workflowFailureAlertOverrides} AS ov
            JOIN ${workflows} AS w ON w.id = ov.workflow_id
            JOIN ${organization} AS org ON org.id = ov.organization_id
           WHERE ${where}
           LIMIT 200
           FOR UPDATE OF ov SKIP LOCKED
        ) AS old
       WHERE o.workflow_id = old.workflow_id
      RETURNING o.workflow_id, o.organization_id, old.name, old.muted_by,
                old.muted_at::text AS muted_at, old.updated_at::text AS updated_at,
                old.mute_reason, old.muted_until::text AS muted_until,
                old.mute_until_success, old.gone
    `);
    const utc = (text: string): Date => new Date(`${text.replace(" ", "T")}Z`);
    const list: EndedMute[] = [...rows].map((r) => ({
      workflowId: r.workflow_id,
      organizationId: r.organization_id,
      name: r.name,
      mutedBy: r.muted_by,
      mutedAt: r.muted_at ? utc(r.muted_at) : null,
      updatedAt: utc(r.updated_at),
      reason: r.mute_reason,
      until: r.muted_until ? utc(r.muted_until) : null,
      untilItWorks: r.mute_until_success,
      gone: r.gone,
    }));
    for (const mute of list.filter((m) => !m.gone)) {
      await tellMuteEnded(mute, ended, now, tx);
    }
    return list.length;
  });
}

async function tellMuteEnded(
  mute: EndedMute,
  ended: "expired" | "worked",
  now: Date,
  tx: Tx
): Promise<void> {
  const [members, policy] = await Promise.all([
    loadOrgMembers(mute.organizationId),
    loadEffectivePolicy(mute.organizationId, mute.workflowId),
  ]);
  const since = mute.mutedAt ?? mute.updatedAt;
  const [failedRuns, failingNow] = await Promise.all([
    failedRunsSince(mute.workflowId, since),
    ended === "worked" ? false : latestRunFailed(mute.workflowId),
  ]);
  if (isFailureAlertsEnabledForOrg(mute.organizationId)) {
    await queueWorkflowNotice({
      organizationId: mute.organizationId,
      workflow: { id: mute.workflowId, name: mute.name },
      kind: "mute_ended",
      policy,
      members,
      context: {
        mutedBy: nameOf(mute.mutedBy, members),
        reason: mute.reason,
        until: mute.until?.toISOString() ?? null,
        untilItWorks: mute.untilItWorks,
        ended,
        failedRuns,
        failingNow,
        alertsPausedUntil:
          policy.orgPausedUntil && policy.orgPausedUntil > now
            ? policy.orgPausedUntil.toISOString()
            : null,
      },
      now,
      tx,
    });
  }
  // An incident left open under the mute is owed a reminder now, not a day later.
  if (failingNow) {
    await tx
      .update(workflowFailureIncidents)
      .set({ lastNotifiedAt: new Date(now.getTime() - REMINDER_INTERVAL_MS) })
      .where(
        and(
          eq(workflowFailureIncidents.workflowId, mute.workflowId),
          isNull(workflowFailureIncidents.resolvedAt)
        )
      );
  }
  // Still failing with no incident: the evaluator alerts now, as if the mute had never been.
  await tx.execute(sql`
    INSERT INTO ${workflowFailureAlertQueue} (workflow_id, due_at)
    SELECT id, now() FROM ${workflows}
    WHERE id = ${mute.workflowId} AND enabled = true AND deleted_at IS NULL
    ON CONFLICT (workflow_id) DO UPDATE SET due_at = now()
  `);
}

/** Mutes whose time ran out. */
export async function endExpiredMutes(now: Date): Promise<number> {
  return await endMutes(
    sql`ov.muted_until IS NOT NULL AND ov.muted_until <= ${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'`,
    "expired",
    now
  );
}

/** An "until it works" mute on a workflow whose run `successRunId` worked after it was muted. */
export async function endMuteBecauseItWorks(
  workflowId: string,
  successRunId: string,
  now: Date
): Promise<boolean> {
  const ended = await endMutes(
    sql`ov.workflow_id = ${workflowId} AND ov.mute_until_success
      AND EXISTS (SELECT 1 FROM ${workflowExecutions} AS ok
        WHERE ok.id = ${successRunId}
          AND ok.started_at > coalesce(ov.muted_at, ov.updated_at))`,
    "worked",
    now
  );
  return ended > 0;
}
