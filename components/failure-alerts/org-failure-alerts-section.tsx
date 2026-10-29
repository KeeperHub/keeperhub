"use client";

import { ChevronRight, Pause as PauseIcon, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  EmptyState,
  SectionHeader,
  SettingsCard,
} from "@/components/settings/hub/section";
import { FormSkeleton } from "@/components/settings/hub/skeletons";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import type {
  ChannelView,
  OrgSettingsView,
} from "@/lib/notifications/failure-alerts/view-types";
import { AlertsStatus } from "./alerts-status";
import { fetchView } from "./api";
import { CustomWorkflowsList } from "./custom-workflows";
import { describeRule } from "./format";
import { memberLabel } from "./member-label";
import { MessagePreviewDialog } from "./message-preview-dialog";
import {
  ChannelMethodCard,
  EmailMethodCard,
  focusMethodAt,
} from "./method-card";
import {
  type ChannelPayload,
  channelPayload,
  channelWorks,
  type DraftChannel,
  draftFromView,
  isChannelDirty,
  newMethodDraft,
  sameTarget,
} from "./method-drafts";
import { NotificationHistory } from "./notification-history";
import { PauseAlertsForm } from "./pause-alerts";
import type { SaveRefusal } from "./save-state";
import { UnsavedChangesGuard } from "./unsaved-guard";
import {
  type RulesDraft,
  rulesDirty,
  rulesDraftFrom,
  WhenToNotify,
} from "./when-to-notify";

type Loaded = OrgSettingsView & {
  canManage: boolean;
  viewerUserId: string;
};

const ALERTS_DESCRIPTION =
  "Tells your team when a workflow that runs on its own keeps failing, or a scheduled run does not start.";

type PutResult =
  | { ok: true; body: Loaded }
  | { ok: false; refusal: SaveRefusal };

/** The tap targets below sm stay at least 44px tall. */
const SUMMARY_CLASS =
  "flex min-h-11 cursor-pointer list-none items-center gap-1 text-muted-foreground text-xs hover:text-foreground sm:min-h-0";

/** The saved rule as a sentence, naming the viewer as "you". */
function ruleSentence(data: Loaded): string {
  const emails = data.members
    .filter((m) => m.reachable && data.recipientUserIds.includes(m.userId))
    .map(memberLabel);
  const viewer = data.members.find((m) => m.userId === data.viewerUserId);
  return describeRule({
    threshold: data.threshold,
    timeLimitMinutes: data.timeLimitMinutes,
    emails,
    viewerEmail: viewer ? memberLabel(viewer) : null,
    channels: data.channels,
    scope: "org",
  });
}

function savedChannelsPayload(channels: ChannelView[]): ChannelPayload[] {
  return channels.map((c) => channelPayload(draftFromView(c)));
}

/** The settings exactly as last saved: the base every card's Save starts from. */
function basePayload(saved: Loaded): Record<string, unknown> {
  return {
    version: saved.version,
    threshold: saved.threshold,
    timeLimitMinutes: saved.timeLimitMinutes,
    remindDaily: saved.remindDaily,
    notifyRecovery: saved.notifyRecovery,
    recipientUserIds: saved.recipientUserIds,
    channels: savedChannelsPayload(saved.channels),
  };
}

/** Saved cards follow the server's list, keeping their drafts; new ones stay last. */
function reconcile(cards: DraftChannel[], saved: Loaded): DraftChannel[] {
  const byId = new Map(cards.filter((c) => c.id).map((c) => [c.id, c]));
  return [
    ...saved.channels.map((view) => byId.get(view.id) ?? draftFromView(view)),
    ...cards.filter((c) => !c.id),
  ];
}

function LoadingCards(): React.ReactElement {
  return (
    <>
      <SettingsCard title="Status">
        <FormSkeleton rows={2} />
      </SettingsCard>
      <SettingsCard title="Rules">
        <FormSkeleton rows={4} />
      </SettingsCard>
      <SettingsCard title="Methods">
        <FormSkeleton rows={4} />
      </SettingsCard>
    </>
  );
}

/** The Alerts settings page; each card saves on its own, on top of the last save. */
export function OrgFailureAlertsSection({
  organizationId,
}: {
  organizationId: string | null;
}): React.ReactElement {
  const [data, setData] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [rules, setRules] = useState<RulesDraft | null>(null);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [cards, setCards] = useState<DraftChannel[]>([]);
  const [pausing, setPausing] = useState(false);
  const savedRef = useRef<Loaded | null>(null);
  const cardsRef = useRef<DraftChannel[]>([]);
  cardsRef.current = cards;
  const methodsRef = useRef<HTMLUListElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  // Saves run one after another, each on top of the one before.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const url = `/api/organizations/${encodeURIComponent(organizationId ?? "")}/failure-alerts`;

  const accept = useCallback((body: Loaded): void => {
    savedRef.current = body;
    setData(body);
    setCards((current) => reconcile(current, body));
  }, []);

  /** Load, or reload after someone else saved: every draft starts over. */
  const load = useCallback(
    async (isActive: () => boolean = () => true): Promise<void> => {
      setLoadFailed(false);
      try {
        const body = await fetchView<Loaded>(url);
        if (!isActive()) {
          return;
        }
        savedRef.current = body;
        setData(body);
        setCards((current) => [
          ...body.channels.map(draftFromView),
          ...current.filter((c) => !c.id),
        ]);
        setRules(rulesDraftFrom(body));
        setRecipients([...body.recipientUserIds]);
      } catch {
        if (isActive()) {
          setLoadFailed(true);
        }
      }
    },
    [url]
  );

  useEffect(() => {
    if (!organizationId) {
      return;
    }
    let active = true;
    load(() => active).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [load, organizationId]);

  const reload = useCallback((): void => {
    load().catch(() => undefined);
  }, [load]);

  /** Health or connections changed on the server: refresh, keep every draft. */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      accept(await fetchView<Loaded>(url));
    } catch {
      // The next save or reload picks it up.
    }
  }, [accept, url]);

  const send = useCallback(
    (
      method: "PUT" | "DELETE",
      path: string,
      build: ((saved: Loaded) => Record<string, unknown>) | null
    ): Promise<PutResult> => {
      const run = async (): Promise<PutResult> => {
        const saved = savedRef.current;
        if (!saved) {
          return {
            ok: false,
            refusal: { message: "The settings are still loading." },
          };
        }
        try {
          const res = await fetch(`${url}${path}`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: build ? JSON.stringify(build(saved)) : undefined,
          });
          const body = (await res.json().catch(() => ({}))) as Loaded & {
            error?: string;
          };
          if (!res.ok) {
            return {
              ok: false,
              refusal: {
                message: body.error ?? `Could not save (HTTP ${res.status}).`,
                stale: res.status === 409,
              },
            };
          }
          return { ok: true, body };
        } catch {
          return {
            ok: false,
            refusal: {
              message:
                "Could not reach KeeperHub. Check your connection and try again.",
            },
          };
        }
      };
      const next = queueRef.current.then(run);
      queueRef.current = next;
      return next;
    },
    [url]
  );

  const put = useCallback(
    (build: (saved: Loaded) => Record<string, unknown>): Promise<PutResult> =>
      send("PUT", "", build),
    [send]
  );

  if (!(data && rules)) {
    const header = (
      <SectionHeader description={ALERTS_DESCRIPTION} title="Alerts" />
    );
    if (loadFailed) {
      return (
        <>
          {header}
          <Notice role="alert" tone="danger">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              Could not load alert settings.
              <Button
                className="h-auto px-0 text-xs"
                onClick={reload}
                type="button"
                variant="link"
              >
                Try again
              </Button>
            </span>
          </Notice>
        </>
      );
    }
    return (
      <>
        {header}
        <LoadingCards />
      </>
    );
  }

  if (!data.enabled) {
    return (
      <div data-testid="failure-alerts-unavailable">
        <SectionHeader description={ALERTS_DESCRIPTION} title="Alerts" />
        <SettingsCard className="mt-4 md:mt-6">
          <EmptyState>
            Alerts are not available for this organization yet.
          </EmptyState>
        </SettingsCard>
      </div>
    );
  }

  const orgId = organizationId ?? "";
  const canManage = data.canManage;
  const pause =
    data.pause && new Date(data.pause.until).getTime() > Date.now()
      ? data.pause
      : null;
  const emailReaches = data.members.some(
    (m) => m.reachable && data.recipientUserIds.includes(m.userId)
  );
  const recipientsDirty =
    recipients.length !== data.recipientUserIds.length ||
    recipients.some((id) => !data.recipientUserIds.includes(id));
  const anyDirty =
    rulesDirty(rules, data) ||
    recipientsDirty ||
    cards.some((c) =>
      isChannelDirty(
        c,
        data.channels.find((v) => v.id === c.id)
      )
    );

  /** Nobody else can be told if this saved method is broken. */
  const lastResort = (id: string | undefined): boolean =>
    !(
      emailReaches || data.channels.some((c) => c.id !== id && channelWorks(c))
    );

  const pauseAlerts = async (body: {
    until: string;
    reason?: string;
  }): Promise<string | null> => {
    const result = await send("PUT", "/pause", () => body);
    if (!result.ok) {
      return result.refusal.message;
    }
    accept(result.body);
    setPausing(false);
    return null;
  };

  const resumeAlerts = async (): Promise<string | null> => {
    const result = await send("DELETE", "/pause", null);
    if (!result.ok) {
      return result.refusal.message;
    }
    accept(result.body);
    return null;
  };

  const saveRules = async (): Promise<SaveRefusal | null> => {
    const draft = rules;
    const result = await put((saved) => ({
      ...basePayload(saved),
      threshold: Number(draft.threshold),
      timeLimitMinutes: draft.timeLimitMinutes,
      remindDaily: draft.remindDaily,
      notifyRecovery: draft.notifyRecovery,
    }));
    if (!result.ok) {
      return result.refusal;
    }
    accept(result.body);
    setRules(rulesDraftFrom(result.body));
    return null;
  };

  const saveRecipients = async (): Promise<SaveRefusal | null> => {
    const chosen = recipients;
    const result = await put((saved) => ({
      ...basePayload(saved),
      recipientUserIds: chosen,
    }));
    if (!result.ok) {
      return result.refusal;
    }
    accept(result.body);
    setRecipients([...result.body.recipientUserIds]);
    return null;
  };

  const saveCard = async (key: string): Promise<SaveRefusal | null> => {
    const card = cardsRef.current.find((c) => c.key === key);
    if (!card) {
      return { message: "This method is no longer on the page." };
    }
    const result = await put((saved) => {
      const channels = savedChannelsPayload(saved.channels);
      const index = card.id ? channels.findIndex((c) => c.id === card.id) : -1;
      const mine = channelPayload({
        ...card,
        destination: card.destination.trim(),
      });
      if (index >= 0) {
        channels[index] = mine;
      } else {
        channels.push({ ...mine, id: undefined });
      }
      return { ...basePayload(saved), channels };
    });
    if (!result.ok) {
      return result.refusal;
    }
    // A new card takes the id of the row the server made for it.
    const taken = new Set(
      cardsRef.current.filter((c) => c.key !== key && c.id).map((c) => c.id)
    );
    const id = result.body.channels.some((v) => v.id === card.id)
      ? card.id
      : result.body.channels.find(
          (v) =>
            !taken.has(v.id) &&
            sameTarget(v, { ...card, destination: card.destination.trim() })
        )?.id;
    setCards((current) =>
      current.map((c) =>
        c.key === key
          ? {
              ...c,
              id,
              destination: c.destination.trim(),
              fresh: false,
              pausedReason: undefined,
            }
          : c
      )
    );
    accept(result.body);
    return null;
  };

  const restore = async (view: ChannelView, index: number): Promise<void> => {
    const result = await put((saved) => {
      const channels = savedChannelsPayload(saved.channels);
      if (!channels.some((c) => sameTarget(c, view))) {
        // A paused channel comes back paused, not live.
        channels.splice(Math.min(index, channels.length), 0, {
          kind: view.kind,
          integrationId: view.integrationId,
          destination: view.destination,
          role: view.role,
          pausedReason: view.pausedAt
            ? (view.pausedReason ?? "It stopped working.")
            : undefined,
        });
      }
      return { ...basePayload(saved), channels };
    });
    if (result.ok) {
      accept(result.body);
    } else {
      toast.error(result.refusal.message);
    }
  };

  const removeCard = async (key: string, label: string): Promise<void> => {
    const position = cardsRef.current.findIndex((c) => c.key === key);
    const card = cardsRef.current[position];
    if (!card) {
      return;
    }
    const view = card.id
      ? savedRef.current?.channels.find((c) => c.id === card.id)
      : undefined;
    if (!view) {
      setCards((current) => current.filter((c) => c.key !== key));
      focusMethodAt(methodsRef, Number.POSITIVE_INFINITY, addRef);
      return;
    }
    const index = savedRef.current?.channels.indexOf(view) ?? 0;
    const result = await put((saved) => ({
      ...basePayload(saved),
      channels: savedChannelsPayload(
        saved.channels.filter((c) => c.id !== view.id)
      ),
    }));
    if (!result.ok) {
      toast.error(result.refusal.message);
      return;
    }
    accept(result.body);
    // Email is the first row, so the next method sits at position + 1.
    focusMethodAt(methodsRef, position + 1, addRef);
    toast(`${label} removed`, {
      action: { label: "Undo", onClick: () => restore(view, index) },
    });
  };

  const addMethod = (): void => {
    setCards((current) => [...current, newMethodDraft(data.connections)]);
    focusMethodAt(methodsRef, cards.length + 1, null);
  };

  return (
    <div
      className="flex flex-col gap-4 md:gap-6"
      data-testid="failure-alerts-settings"
    >
      <UnsavedChangesGuard dirty={anyDirty} />
      <SectionHeader
        action={
          canManage && !pause && !pausing ? (
            <Button
              data-testid="failure-alerts-pause"
              onClick={() => setPausing(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              <PauseIcon className="size-3.5" />
              Pause alerts
            </Button>
          ) : undefined
        }
        description={
          <>
            <span data-testid="failure-alerts-rule-sentence">
              {ruleSentence(data)}
            </span>
            {!canManage && (
              <span className="mt-1 block">
                Only owners and admins can change alert settings.
              </span>
            )}
          </>
        }
        title="Alerts"
      />
      {pausing && !pause && (
        <PauseAlertsForm
          onCancel={() => setPausing(false)}
          onPause={pauseAlerts}
          pausingWorkflows={
            data.customWorkflows.filter((w) => w.pauseWorkflow).length
          }
        />
      )}

      <SettingsCard title="Status">
        <AlertsStatus
          canManage={canManage}
          data={data}
          onResume={resumeAlerts}
        />
      </SettingsCard>

      <SettingsCard description="Apply to every method." title="Rules">
        <WhenToNotify
          canManage={canManage}
          draft={rules}
          onChange={setRules}
          onReload={reload}
          onSave={saveRules}
          saved={data}
        />
      </SettingsCard>

      <SettingsCard
        action={<MessagePreviewDialog organizationId={orgId} />}
        description="Who gets alerts, and how. Each method is checked before it is saved and again every day."
        title="Methods"
      >
        <div className="space-y-4" data-testid="failure-alerts-methods">
          <ul aria-label="Alert methods" className="space-y-3" ref={methodsRef}>
            <EmailMethodCard
              canManage={canManage}
              emailUsage={data.emailUsage}
              members={data.members}
              onChange={setRecipients}
              onReload={reload}
              onSave={saveRecipients}
              organizationId={orgId}
              recipients={recipients}
              savedRecipients={data.recipientUserIds}
            />
            {cards.map((card) => (
              <ChannelMethodCard
                canManage={canManage}
                connections={data.connections}
                draft={card}
                key={card.key}
                lastResort={lastResort(card.id)}
                onChange={(next) =>
                  setCards((current) =>
                    current.map((c) => (c.key === next.key ? next : c))
                  )
                }
                onConnectionsChanged={refresh}
                onReload={reload}
                onRemove={(label) => removeCard(card.key, label)}
                onSave={() => saveCard(card.key)}
                onTested={refresh}
                organizationId={orgId}
                saved={data.channels.find((c) => c.id === card.id)}
                unsharedConnections={data.unsharedConnections}
              />
            ))}
          </ul>
          {canManage && (
            <Button
              data-testid="failure-alerts-add-method"
              onClick={addMethod}
              ref={addRef}
              size="sm"
              type="button"
              variant="outline"
            >
              <Plus className="size-3.5" />
              Add a method
            </Button>
          )}
          <details className="group text-xs">
            <summary className={SUMMARY_CLASS}>
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
              How delivery works
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-8 text-muted-foreground">
              <li>
                Each alert goes out once per failing streak, not on every failed
                run.
              </li>
              <li>
                If email or chat cannot deliver for 15 minutes, or PagerDuty for
                2, the alert goes to your backup methods and to email, saying
                what failed. Retries continue for 24 hours.
              </li>
              <li>
                A method that stops working is paused and everyone is told once.
                It is checked again every day and turns back on by itself when
                it works.
              </li>
              <li>
                Only connections shared with the whole organization can be used.
              </li>
            </ul>
          </details>
        </div>
      </SettingsCard>

      {data.customWorkflows.length > 0 && (
        <SettingsCard
          description="Set in each workflow's Properties. They do not follow the rules above."
          title="Workflows with their own settings"
        >
          <CustomWorkflowsList workflows={data.customWorkflows} />
        </SettingsCard>
      )}

      <SettingsCard
        description="Every alert, test and warning, where it went, and whether it arrived."
        title="Sent alerts"
      >
        <NotificationHistory organizationId={orgId} />
      </SettingsCard>
    </div>
  );
}
