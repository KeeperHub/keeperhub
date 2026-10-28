import "server-only";

import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  failureAlertChannels,
  failureAlertDeliveries,
  workflowExecutions,
  workflowFailureAlertOverrides,
  workflowFailureIncidents,
  workflows,
} from "@/lib/db/schema";
import { loadOrgMembers } from "@/lib/notifications/org-recipients";
import type { TriggerNodeLike } from "@/lib/workflow/trigger-display-key";
import { MAX_MUTE_DAYS } from "./constants";
import {
  loadEffectivePolicy,
  loadOverride,
  resolveRecipientEmails,
} from "./policy";
import type { Tx } from "./queue-rows";
import {
  checkVersion,
  loadChannelViews,
  loadOrgSettingsView,
  loadUsableConnections,
  lockOrgSettings,
  parseChannels,
  parseThreshold,
  parseTimeLimit,
  parseVersion,
  replaceChannels,
  SettingsError,
  toMemberView,
} from "./settings";
import { summarizeStreak } from "./streak";
import type { WorkflowAlertView } from "./view-types";
import { runsOnItsOwn, workflowTriggerType } from "./workflow-trigger";

export async function loadWorkflowForAlerts(workflowId: string): Promise<{
  id: string;
  organizationId: string;
  enabled: boolean;
  nodes: TriggerNodeLike[];
} | null> {
  const [row] = await db
    .select({
      id: workflows.id,
      organizationId: workflows.organizationId,
      enabled: workflows.enabled,
      nodes: workflows.nodes,
    })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), isNull(workflows.deletedAt)))
    .limit(1);
  return row ?? null;
}

const STATUS_WINDOW = 80;

export async function loadWorkflowAlertView(
  workflow: {
    id: string;
    organizationId: string;
    enabled: boolean;
    nodes: TriggerNodeLike[];
  },
  viewerUserId: string
): Promise<WorkflowAlertView> {
  const [org, override, policy, members, connections, workflowChannels] =
    await Promise.all([
      loadOrgSettingsView(workflow.organizationId, viewerUserId),
      loadOverride(workflow.id),
      loadEffectivePolicy(workflow.organizationId, workflow.id),
      loadOrgMembers(workflow.organizationId),
      loadUsableConnections(workflow.organizationId),
      loadChannelViews(workflow.organizationId, workflow.id),
    ]);

  const runs = await db
    .select({
      id: workflowExecutions.id,
      status: workflowExecutions.status,
      triggerSource: workflowExecutions.triggerSource,
      credentialType: workflowExecutions.triggeredByCredentialType,
      startedAt: workflowExecutions.startedAt,
      completedAt: workflowExecutions.completedAt,
      error: workflowExecutions.error,
    })
    .from(workflowExecutions)
    .where(
      and(
        eq(workflowExecutions.workflowId, workflow.id),
        isNotNull(workflowExecutions.completedAt),
        isNull(workflowExecutions.deletedAt)
      )
    )
    .orderBy(desc(workflowExecutions.startedAt))
    .limit(STATUS_WINDOW);
  const summary = summarizeStreak(runs, policy.countingSince, STATUS_WINDOW);

  const [incident] = await db
    .select()
    .from(workflowFailureIncidents)
    .where(
      and(
        eq(workflowFailureIncidents.workflowId, workflow.id),
        isNull(workflowFailureIncidents.resolvedAt)
      )
    )
    .limit(1);
  const deliveredTo = incident
    ? await db
        .selectDistinct({
          channel: failureAlertDeliveries.channel,
          recipient: failureAlertDeliveries.recipient,
        })
        .from(failureAlertDeliveries)
        .where(
          and(
            eq(failureAlertDeliveries.incidentId, incident.id),
            eq(failureAlertDeliveries.state, "delivered")
          )
        )
    : [];

  const trigger = workflowTriggerType(workflow.nodes);
  const channelViews = override?.customChannels
    ? workflowChannels
    : org.channels;

  return {
    workflowId: workflow.id,
    organizationId: workflow.organizationId,
    applies: runsOnItsOwn(trigger),
    triggerType: trigger,
    enabled: workflow.enabled,
    org: {
      threshold: org.threshold,
      timeLimitMinutes: org.timeLimitMinutes,
      recipientUserIds: org.recipientUserIds,
      channels: org.channels,
      unreachable: org.unreachable,
      emailUsage: org.emailUsage,
      pause: org.pause,
    },
    version: override?.version ?? 0,
    override: {
      threshold: override?.threshold ?? null,
      timeLimitMinutes: override?.timeLimitMinutes ?? null,
      recipientUserIds: override?.recipientUserIds ?? null,
      customChannels: override?.customChannels ?? false,
      channels: workflowChannels,
      // Drop an ended mute: it would show "Muted" and be refused when saved back.
      mutedUntil:
        override?.mutedUntil && override.mutedUntil > new Date()
          ? override.mutedUntil.toISOString()
          : null,
      muteUntilSuccess: override?.muteUntilSuccess ?? false,
      muteReason: override?.muteReason ?? null,
      mutedBy:
        members.find((m) => m.userId === override?.mutedBy)?.deliverable ??
        null,
      pauseWorkflow: override?.pauseWorkflow ?? false,
    },
    effective: {
      threshold: policy.threshold,
      timeLimitMinutes: policy.timeLimitMinutes,
      emails: resolveRecipientEmails(policy.recipientUserIds, members),
      channels: channelViews,
      source: policy.source,
    },
    status: {
      failures: summary.failures,
      firstFailedAt: summary.firstFailedAt?.toISOString() ?? null,
      lastError: summary.lastError,
      incident: incident
        ? {
            openedAt: incident.openedAt.toISOString(),
            failureCount: incident.failureCount,
            threshold: incident.threshold,
            lastNotifiedAt: incident.lastNotifiedAt.toISOString(),
            deliveredTo: deliveredTo.map((d) =>
              d.channel === "email"
                ? d.recipient
                : `${d.channel} ${d.recipient}`
            ),
            openedBy: incident.openedBy,
            since: incident.firstFailedAt.toISOString(),
            workflowPausedAt: incident.workflowPausedAt?.toISOString() ?? null,
            workflowResumedAt:
              incident.workflowResumedAt?.toISOString() ?? null,
          }
        : null,
    },
    members: members.map(toMemberView),
    connections,
  };
}

function parseMute(
  body: Record<string, unknown>,
  now: Date
): {
  mutedUntil: Date | null;
  muteUntilSuccess: boolean;
  muteReason: string | null;
} {
  const untilSuccess = body.muteUntilSuccess === true;
  let mutedUntil: Date | null = null;
  if (typeof body.mutedUntil === "string" && body.mutedUntil) {
    mutedUntil = new Date(body.mutedUntil);
    if (Number.isNaN(mutedUntil.getTime()) || mutedUntil <= now) {
      throw new SettingsError("Pick a mute end in the future.");
    }
    const max = new Date(now.getTime() + MAX_MUTE_DAYS * 24 * 60 * 60 * 1000);
    if (mutedUntil > max) {
      throw new SettingsError(`A mute can last at most ${MAX_MUTE_DAYS} days.`);
    }
  }
  const reason =
    typeof body.muteReason === "string"
      ? body.muteReason.trim().slice(0, 200)
      : "";
  // "Until it works" still ends after MAX_MUTE_DAYS, so no mute is forever.
  if (untilSuccess && !mutedUntil) {
    mutedUntil = new Date(now.getTime() + MAX_MUTE_DAYS * 24 * 60 * 60 * 1000);
  }
  return {
    mutedUntil,
    muteUntilSuccess: untilSuccess,
    muteReason: mutedUntil && reason ? reason : null,
  };
}

/** Save a workflow override; an empty one is removed with its channels. */
export async function saveWorkflowOverride(params: {
  workflowId: string;
  organizationId: string;
  userId: string;
  body: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { workflowId, organizationId, userId, body } = params;
  const now = new Date();

  const threshold =
    body.threshold === null || body.threshold === undefined
      ? null
      : parseThreshold(body.threshold);
  let timeLimitMinutes: number | null = null;
  if (body.timeLimitMinutes === 0 || body.timeLimitMinutes === "off") {
    timeLimitMinutes = 0;
  } else if (
    body.timeLimitMinutes !== null &&
    body.timeLimitMinutes !== undefined
  ) {
    timeLimitMinutes = parseTimeLimit(body.timeLimitMinutes);
  }

  let recipientUserIds: string[] | null = null;
  if (Array.isArray(body.recipientUserIds)) {
    const members = await loadOrgMembers(organizationId);
    const ids = new Set(members.map((m) => m.userId));
    recipientUserIds = [
      ...new Set(
        (body.recipientUserIds as unknown[]).filter(
          (id): id is string => typeof id === "string" && ids.has(id)
        )
      ),
    ];
    if (recipientUserIds.length === 0) {
      throw new SettingsError("Choose at least one person to email.");
    }
    if (
      members.some((m) => m.deliverable) &&
      !members.some(
        (m) => recipientUserIds?.includes(m.userId) && m.deliverable
      )
    ) {
      throw new SettingsError(
        "None of the people you chose can receive email yet. Choose someone with a verified email."
      );
    }
  }

  const customChannels = body.customChannels === true;
  const channels = customChannels
    ? await parseChannels(body.channels, organizationId, { verify: true })
    : [];
  const mute = parseMute(body, now);
  const expectedVersion = parseVersion(body.version);
  const currentVersion = async (tx: Tx): Promise<number> => {
    const [row] = await tx
      .select({ version: workflowFailureAlertOverrides.version })
      .from(workflowFailureAlertOverrides)
      .where(eq(workflowFailureAlertOverrides.workflowId, workflowId));
    return row?.version ?? 0;
  };
  const pauseWorkflow = body.pauseWorkflow === true;

  const empty =
    threshold === null &&
    timeLimitMinutes === null &&
    recipientUserIds === null &&
    !customChannels &&
    !mute.mutedUntil &&
    !mute.muteUntilSuccess &&
    !pauseWorkflow;

  if (empty) {
    await db.transaction(async (tx: Tx) => {
      await lockOrgSettings(tx, organizationId);
      checkVersion(expectedVersion, await currentVersion(tx));
      await tx
        .delete(workflowFailureAlertOverrides)
        .where(eq(workflowFailureAlertOverrides.workflowId, workflowId));
      await tx
        .delete(failureAlertChannels)
        .where(eq(failureAlertChannels.workflowId, workflowId));
    });
    return { reset: true };
  }

  const muted = Boolean(mute.mutedUntil || mute.muteUntilSuccess);
  const values = {
    threshold,
    timeLimitMinutes,
    recipientUserIds,
    customChannels,
    mutedUntil: mute.mutedUntil,
    muteUntilSuccess: mute.muteUntilSuccess,
    muteReason: mute.muteReason,
    mutedBy: muted ? userId : null,
    pauseWorkflow,
    updatedBy: userId,
    updatedAt: now,
  };
  await db.transaction(async (tx: Tx) => {
    await lockOrgSettings(tx, organizationId);
    const current = await currentVersion(tx);
    checkVersion(expectedVersion, current);
    const next = { ...values, version: current + 1 };
    await tx
      .insert(workflowFailureAlertOverrides)
      .values({ workflowId, organizationId, ...next })
      .onConflictDoUpdate({
        target: workflowFailureAlertOverrides.workflowId,
        set: next,
      });
    await replaceChannels(tx, organizationId, workflowId, channels, userId);
  });

  return {
    threshold,
    timeLimitMinutes,
    recipientUserIds,
    customChannels,
    channels: channels.map((c) => ({
      kind: c.kind,
      integrationId: c.integrationId,
      destination: c.destination,
      role: c.role,
    })),
    mutedUntil: mute.mutedUntil?.toISOString() ?? null,
    muteUntilSuccess: mute.muteUntilSuccess,
    pauseWorkflow,
  };
}
