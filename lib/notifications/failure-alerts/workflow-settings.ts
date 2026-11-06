import "server-only";

import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  failureAlertChannels,
  failureAlertDeliveries,
  integrations,
  workflowFailureAlertOverrides,
  workflowFailureIncidents,
  workflows,
} from "@/lib/db/schema";
import type { Tx } from "@/lib/db/tx";
import { oneLine } from "@/lib/notifications/chat-text";
import {
  loadOrgMembers,
  stepUpMasker,
} from "@/lib/notifications/org-recipients";
import type { TriggerNodeLike } from "@/lib/workflow/trigger-display-key";
import { signInAccounts } from "./accounts";
import {
  CLOCK_SKEW_MS,
  MAX_MUTE_DAYS,
  MAX_MUTE_REASON,
  MIN_MUTE_REASON,
  MUTE_CHANGES_PER_HOUR,
} from "./constants";
import { parseEndTime } from "./end-time";
import {
  actorOf,
  nameOf,
  queueRemovedNotice,
  queueWorkflowNotice,
} from "./mute-notices";
import {
  effectiveRecipientIds,
  hasReachableManager,
  loadEffectivePolicy,
  loadOrgPolicy,
  loadOverride,
  recipientIdsFor,
  resolveRecipientEmails,
} from "./policy";
import {
  checkVersion,
  loadChannelViews,
  loadOrgSettingsView,
  loadUsableConnections,
  lockOrgSettings,
  MANAGER_REQUIRED,
  parseChannels,
  parseThreshold,
  parseTimeLimit,
  parseVersion,
  replaceChannels,
  SettingsError,
  toMemberView,
} from "./settings";
import { summarizeStreak } from "./streak";
import { loadStreakRuns } from "./streak-runs";
import {
  isRefusedIncident,
  methodText,
  refusedReasonOf,
  type WorkflowAlertView,
} from "./view-types";
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

  const runs = await loadStreakRuns(workflow.id, STATUS_WINDOW);
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
          connectionName: integrations.name,
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
        .where(
          and(
            eq(failureAlertDeliveries.incidentId, incident.id),
            eq(failureAlertDeliveries.state, "delivered")
          )
        )
    : [];

  const mask = await stepUpMasker(
    [
      ...members.map((m) => m.deliverable),
      ...deliveredTo
        .filter((d) => d.channel === "email")
        .map((d) => d.recipient),
    ],
    viewerUserId
  );
  const mutedByAccount = override?.mutedBy
    ? (await signInAccounts([override.mutedBy])).get(override.mutedBy)
    : null;
  const muteActive = Boolean(
    override?.mutedUntil && override.mutedUntil > new Date()
  );
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
      remindDaily: org.remindDaily,
      notifyRecovery: org.notifyRecovery,
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
      recipientUserIds: effectiveRecipientIds(
        override?.recipientUserIds ?? null,
        members
      ),
      customChannels: override?.customChannels ?? false,
      channels: workflowChannels,
      // An ended mute is not shown: saved back, it would re-mute.
      mutedUntil: muteActive
        ? (override?.mutedUntil?.toISOString() ?? null)
        : null,
      muteUntilSuccess: muteActive && (override?.muteUntilSuccess ?? false),
      muteReason: muteActive ? (override?.muteReason ?? null) : null,
      mutedBy: muteActive ? nameOf(override?.mutedBy, members) : null,
      mutedByAccount: muteActive ? (mutedByAccount ?? null) : null,
      pauseWorkflow: override?.pauseWorkflow ?? false,
    },
    effective: {
      threshold: policy.threshold,
      timeLimitMinutes: policy.timeLimitMinutes,
      emails: resolveRecipientEmails(policy.recipientUserIds, members).map(
        mask
      ),
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
                ? mask(d.recipient)
                : methodText(
                    d.channel,
                    // A chat row records its kind when it has no destination.
                    d.recipient === d.channel ? "" : d.recipient,
                    d.connectionName
                  )
            ),
            openedBy: incident.openedBy,
            since: incident.firstFailedAt.toISOString(),
            workflowPausedAt: incident.workflowPausedAt?.toISOString() ?? null,
            workflowResumedAt:
              incident.workflowResumedAt?.toISOString() ?? null,
            refused: isRefusedIncident(incident),
            refusedReason: refusedReasonOf(incident),
            lastRefusedAt:
              incident.openedBy === "refused"
                ? incident.lastFailedAt.toISOString()
                : null,
          }
        : null,
    },
    members: members.map((m) => toMemberView(m, mask)),
    connections,
    unsharedConnections: org.unsharedConnections,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Required for every mute or change to one. */
export const MUTE_REASON_REQUIRED = `Say why you are muting (${MIN_MUTE_REASON} to ${MAX_MUTE_REASON} characters).`;

/** The mute as sent; the cap and reason are checked only when it changes. */
function parseMute(
  body: Record<string, unknown>,
  now: Date
): {
  mutedUntil: Date | null;
  muteUntilSuccess: boolean;
  muteReason: string;
} {
  const untilSuccess = body.muteUntilSuccess === true;
  let mutedUntil: Date | null = null;
  if (typeof body.mutedUntil === "string" && body.mutedUntil) {
    mutedUntil = parseEndTime(body.mutedUntil);
    if (!mutedUntil || mutedUntil <= now) {
      throw new SettingsError("Pick a mute end in the future.");
    }
  }
  // "Until it works" still ends after MAX_MUTE_DAYS, so no mute is forever.
  if (untilSuccess && !mutedUntil) {
    mutedUntil = new Date(now.getTime() + MAX_MUTE_DAYS * DAY_MS);
  }
  return {
    mutedUntil,
    muteUntilSuccess: untilSuccess,
    // One line, no control or bidi characters, like an org pause reason.
    muteReason:
      typeof body.muteReason === "string" ? oneLine(body.muteReason) : "",
  };
}

type StoredMute = {
  mutedUntil: Date | null;
  muteUntilSuccess: boolean;
  muteReason: string | null;
  mutedBy: string | null;
  mutedAt: Date | null;
};

/** A stored mute still in force; every mute has an end. */
function activeMute(stored: StoredMute | undefined, now: Date): boolean {
  return Boolean(stored?.mutedUntil && stored.mutedUntil > now);
}

/** How a save changes the mute, and the mute fields to store. */
function nextMute(
  stored: StoredMute | undefined,
  sent: ReturnType<typeof parseMute>,
  userId: string,
  now: Date
): {
  change: "muted" | "changed" | "unmuted" | null;
  fields: StoredMute;
} {
  const wasMuted = activeMute(stored, now);
  const muted = Boolean(sent.mutedUntil || sent.muteUntilSuccess);
  if (!muted) {
    // An ended mute not yet announced stays put: the cycle ends it and tells everyone.
    if (stored?.mutedUntil && !wasMuted) {
      return { change: null, fields: stored };
    }
    return {
      change: wasMuted ? "unmuted" : null,
      fields: {
        mutedUntil: null,
        muteUntilSuccess: false,
        muteReason: null,
        mutedBy: null,
        mutedAt: null,
      },
    };
  }
  const same =
    wasMuted &&
    stored?.muteUntilSuccess === sent.muteUntilSuccess &&
    stored?.mutedUntil?.getTime() === sent.mutedUntil?.getTime() &&
    (!sent.muteReason || sent.muteReason === stored?.muteReason);
  if (same && stored) {
    // An unrelated edit sends the mute back as it was: who muted and why stay.
    return { change: null, fields: stored };
  }
  const cap = now.getTime() + MAX_MUTE_DAYS * DAY_MS;
  if (sent.mutedUntil && sent.mutedUntil.getTime() > cap + CLOCK_SKEW_MS) {
    // Just past the cap is most likely a device clock running ahead of ours.
    const clockAhead = sent.mutedUntil.getTime() <= cap + HOUR_MS;
    throw new SettingsError(
      clockAhead
        ? `A mute can last at most ${MAX_MUTE_DAYS} days, and your device's clock looks ahead of ours. Pick a shorter time.`
        : `A mute can last at most ${MAX_MUTE_DAYS} days.`
    );
  }
  const reason = sent.muteReason;
  if (reason.length < MIN_MUTE_REASON || reason.length > MAX_MUTE_REASON) {
    throw new SettingsError(MUTE_REASON_REQUIRED);
  }
  return {
    change: wasMuted ? "changed" : "muted",
    fields: {
      mutedUntil:
        sent.mutedUntil && sent.mutedUntil.getTime() > cap
          ? new Date(cap)
          : sent.mutedUntil,
      muteUntilSuccess: sent.muteUntilSuccess,
      muteReason: reason,
      mutedBy: userId,
      // A changed mute keeps its start, so the failures it hid are all counted.
      mutedAt: wasMuted ? (stored?.mutedAt ?? now) : now,
    },
  };
}

/** Too many mute notices for one workflow in an hour: refused, so nobody is flooded. */
async function refuseTooManyMuteChanges(
  tx: Tx,
  organizationId: string,
  workflowId: string,
  now: Date
): Promise<void> {
  const [row] = await tx
    .select({
      notices: sql<number>`count(DISTINCT ${failureAlertDeliveries.createdAt})`,
    })
    .from(failureAlertDeliveries)
    .where(
      and(
        eq(failureAlertDeliveries.organizationId, organizationId),
        inArray(failureAlertDeliveries.kind, [
          "workflow_muted",
          "workflow_unmuted",
        ]),
        sql`${failureAlertDeliveries.context}->>'workflowId' = ${workflowId}`,
        gt(
          failureAlertDeliveries.createdAt,
          new Date(now.getTime() - 60 * 60 * 1000)
        )
      )
    );
  if (Number(row?.notices ?? 0) >= MUTE_CHANGES_PER_HOUR) {
    throw new SettingsError(
      `This workflow's mute changed ${MUTE_CHANGES_PER_HOUR} times in the last hour. Try again later.`,
      429
    );
  }
}

/** Save a workflow override; an empty one clears the row and removes its channels. */
export async function saveWorkflowOverride(params: {
  workflowId: string;
  organizationId: string;
  userId: string;
  body: Record<string, unknown>;
}): Promise<
  Record<string, unknown> & {
    rulesChanged: boolean;
    muteChange: "muted" | "changed" | "unmuted" | null;
    muteBefore: StoredMute | null;
    muteAfter: StoredMute;
  }
> {
  const { workflowId, organizationId, userId, body } = params;
  const now = new Date();
  const [members, beforePolicy, orgPolicy, [workflowRow]] = await Promise.all([
    loadOrgMembers(organizationId),
    loadEffectivePolicy(organizationId, workflowId),
    loadOrgPolicy(organizationId),
    db
      .select({ name: workflows.name })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1),
  ]);
  const workflow = { id: workflowId, name: workflowRow?.name ?? "A workflow" };

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
    if (!hasReachableManager(recipientUserIds, members)) {
      throw new SettingsError(MANAGER_REQUIRED);
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
  // Own channels left out of the body stay as they are; only [] clears them.
  let channels: Awaited<ReturnType<typeof parseChannels>> | null = [];
  if (customChannels) {
    channels =
      body.channels === undefined
        ? null
        : await parseChannels(body.channels, organizationId, { verify: true });
  }
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
  const actor = await actorOf(userId, members);
  const orgList = orgPolicy.recipientUserIds;

  // Only what the evaluator reads needs a fresh evaluation; who is told does not.
  let rulesChanged = true;
  let muteChange: "muted" | "changed" | "unmuted" | null = null;
  let muteBefore: StoredMute | null = null;
  let muteAfter: StoredMute = {
    mutedUntil: null,
    muteUntilSuccess: false,
    muteReason: null,
    mutedBy: null,
    mutedAt: null,
  };
  await db.transaction(async (tx: Tx) => {
    await lockOrgSettings(tx, organizationId);
    const current = await currentVersion(tx);
    checkVersion(expectedVersion, current);
    const [stored] = await tx
      .select({
        threshold: workflowFailureAlertOverrides.threshold,
        timeLimitMinutes: workflowFailureAlertOverrides.timeLimitMinutes,
        recipientUserIds: workflowFailureAlertOverrides.recipientUserIds,
        mutedUntil: workflowFailureAlertOverrides.mutedUntil,
        muteUntilSuccess: workflowFailureAlertOverrides.muteUntilSuccess,
        muteReason: workflowFailureAlertOverrides.muteReason,
        mutedBy: workflowFailureAlertOverrides.mutedBy,
        mutedAt: workflowFailureAlertOverrides.mutedAt,
        pauseWorkflow: workflowFailureAlertOverrides.pauseWorkflow,
      })
      .from(workflowFailureAlertOverrides)
      .where(eq(workflowFailureAlertOverrides.workflowId, workflowId))
      // Waits for an ending mute, so a save never writes it back.
      .for("update");
    const decided = nextMute(stored, mute, userId, now);
    if (decided.change) {
      await refuseTooManyMuteChanges(tx, organizationId, workflowId, now);
    }
    muteChange = decided.change;
    muteBefore = stored && activeMute(stored, now) ? stored : null;
    muteAfter = decided.fields;

    if (empty) {
      // An all-empty row follows the org, and keeps its version so a stale tab is still refused.
      await tx
        .update(workflowFailureAlertOverrides)
        .set({
          threshold: null,
          timeLimitMinutes: null,
          recipientUserIds: null,
          customChannels: false,
          ...decided.fields,
          pauseWorkflow: false,
          version: current + 1,
          updatedBy: userId,
          updatedAt: now,
        })
        .where(eq(workflowFailureAlertOverrides.workflowId, workflowId));
      await tx
        .delete(failureAlertChannels)
        .where(eq(failureAlertChannels.workflowId, workflowId));
    } else {
      const values = {
        threshold,
        timeLimitMinutes,
        recipientUserIds,
        customChannels,
        ...decided.fields,
        pauseWorkflow,
        updatedBy: userId,
        updatedAt: now,
      };
      rulesChanged =
        !stored ||
        stored.threshold !== values.threshold ||
        stored.timeLimitMinutes !== values.timeLimitMinutes ||
        stored.mutedUntil?.getTime() !== values.mutedUntil?.getTime() ||
        stored.muteUntilSuccess !== values.muteUntilSuccess ||
        stored.pauseWorkflow !== values.pauseWorkflow;
      const next = { ...values, version: current + 1 };
      await tx
        .insert(workflowFailureAlertOverrides)
        .values({ workflowId, organizationId, ...next })
        .onConflictDoUpdate({
          target: workflowFailureAlertOverrides.workflowId,
          set: next,
        });
      if (channels) {
        await replaceChannels(tx, organizationId, workflowId, channels, userId);
      }
    }

    // Told in the same transaction as the change, to everyone it reached before.
    if (decided.change) {
      const fields = decided.fields;
      await queueWorkflowNotice({
        organizationId,
        workflow,
        kind:
          decided.change === "unmuted" ? "workflow_unmuted" : "workflow_muted",
        policy: beforePolicy,
        members,
        context:
          decided.change === "unmuted"
            ? { ...actor }
            : {
                ...actor,
                reason: fields.muteReason,
                until: fields.mutedUntil?.toISOString() ?? null,
                untilItWorks: fields.muteUntilSuccess,
                changed: decided.change === "changed",
              },
        now,
        tx,
      });
    }
    // Who this workflow emailed before and after, the org's list when it follows it.
    {
      const before = new Set(
        recipientIdsFor(stored?.recipientUserIds ?? orgList, members)
      );
      const after = new Set(
        recipientIdsFor(recipientUserIds ?? orgList, members)
      );
      await queueRemovedNotice({
        organizationId,
        workflow,
        removed: members.filter(
          (m) => before.has(m.userId) && !after.has(m.userId)
        ),
        actor,
        members,
        now,
        tx,
      });
    }
  });

  if (empty) {
    return {
      reset: true,
      rulesChanged: true,
      muteChange,
      muteBefore,
      muteAfter,
    };
  }
  return {
    threshold,
    timeLimitMinutes,
    recipientUserIds,
    customChannels,
    channels: channels?.map((c) => ({
      kind: c.kind,
      integrationId: c.integrationId,
      destination: c.destination,
      role: c.role,
    })),
    mutedUntil: muteAfter.mutedUntil?.toISOString() ?? null,
    muteUntilSuccess: muteAfter.muteUntilSuccess,
    muteReason: muteAfter.muteReason,
    pauseWorkflow,
    rulesChanged,
    muteChange,
    muteBefore,
    muteAfter,
  };
}
