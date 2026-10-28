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
import { MAX_MUTE_DAYS } from "./constants";
import { workflowTriggerType } from "./evaluator";
import {
  loadEffectivePolicy,
  loadOrgMembers,
  loadOverride,
  resolveRecipientEmails,
} from "./policy";
import {
  loadChannelViews,
  loadOrgSettingsView,
  loadUsableConnections,
  parseChannels,
  parseThreshold,
  parseTimeLimit,
  replaceChannels,
  SettingsError,
  toMemberView,
} from "./settings";
import { summarizeStreak } from "./streak";
import type { WorkflowAlertView } from "./view-types";

export type { WorkflowAlertView } from "./view-types";

export async function loadWorkflowForAlerts(workflowId: string): Promise<{
  id: string;
  organizationId: string;
  enabled: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: workflow nodes are JSONB validated at application level
  nodes: any[];
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

export async function loadWorkflowAlertView(workflow: {
  id: string;
  organizationId: string;
  enabled: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: workflow nodes are JSONB validated at application level
  nodes: any[];
}): Promise<WorkflowAlertView> {
  const [org, override, policy, members, connections, workflowChannels] =
    await Promise.all([
      loadOrgSettingsView(workflow.organizationId),
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
    applies: Boolean(trigger && trigger !== "Manual"),
    triggerType: trigger,
    enabled: workflow.enabled,
    org: {
      threshold: org.threshold,
      timeLimitMinutes: org.timeLimitMinutes,
      recipientUserIds: org.recipientUserIds,
      channels: org.channels,
      unreachable: org.unreachable,
      emailUsage: org.emailUsage,
    },
    override: {
      threshold: override?.threshold ?? null,
      timeLimitMinutes: override?.timeLimitMinutes ?? null,
      recipientUserIds: override?.recipientUserIds ?? null,
      customChannels: override?.customChannels ?? false,
      channels: workflowChannels,
      // A mute that has ended is no mute: showing it would say "Muted"
      // about a workflow that alerts again, and sending it back would be
      // refused as a mute in the past.
      mutedUntil:
        override?.mutedUntil && override.mutedUntil > new Date()
          ? override.mutedUntil.toISOString()
          : null,
      muteUntilSuccess: override?.muteUntilSuccess ?? false,
      muteReason: override?.muteReason ?? null,
      mutedBy:
        members.find((m) => m.userId === override?.mutedBy)?.deliverable ??
        null,
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
            lastNotifiedAt: incident.lastNotifiedAt.toISOString(),
            deliveredTo: deliveredTo.map((d) =>
              d.channel === "email"
                ? d.recipient
                : `${d.channel} ${d.recipient}`
            ),
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
  return {
    mutedUntil,
    muteUntilSuccess: untilSuccess && !mutedUntil,
    muteReason: (mutedUntil || untilSuccess) && reason ? reason : null,
  };
}

/**
 * Save a workflow's override. Every field left null follows the org. An
 * override with nothing set is removed, along with its channels.
 */
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
    ? await parseChannels(body.channels, organizationId)
    : [];
  const mute = parseMute(body, now);

  const empty =
    threshold === null &&
    timeLimitMinutes === null &&
    recipientUserIds === null &&
    !customChannels &&
    !mute.mutedUntil &&
    !mute.muteUntilSuccess;

  if (empty) {
    await db
      .delete(workflowFailureAlertOverrides)
      .where(eq(workflowFailureAlertOverrides.workflowId, workflowId));
    await db
      .delete(failureAlertChannels)
      .where(eq(failureAlertChannels.workflowId, workflowId));
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
    updatedBy: userId,
    updatedAt: now,
  };
  await db
    .insert(workflowFailureAlertOverrides)
    .values({ workflowId, organizationId, ...values })
    .onConflictDoUpdate({
      target: workflowFailureAlertOverrides.workflowId,
      set: values,
    });
  await replaceChannels(organizationId, workflowId, channels, userId);

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
  };
}
