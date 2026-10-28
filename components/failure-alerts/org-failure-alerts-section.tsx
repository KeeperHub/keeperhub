"use client";

import { ChevronRight, Pause as PauseIcon, Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { timeAgo } from "@/components/settings/hub/relative-time";
import { SectionHeader, SettingsCard } from "@/components/settings/hub/section";
import { FormSkeleton } from "@/components/settings/hub/skeletons";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import {
  type ChannelView,
  channelLabel,
  type OrgSettingsView,
} from "@/lib/notifications/failure-alerts/view-types";
import { fetchView } from "./api";
import { failedRuns } from "./format";
import { MessagePreviewDialog } from "./message-preview-dialog";
import { ChannelMethodCard, EmailMethodCard } from "./method-card";
import {
  type ChannelPayload,
  channelPayload,
  type DraftChannel,
  draftFromView,
  newMethodDraft,
  sameTarget,
} from "./method-drafts";
import { NotificationHistory } from "./notification-history";
import { AlertsPausedNotice, PauseAlertsForm } from "./pause-alerts";
import {
  type RulesDraft,
  rulesDraftFrom,
  WhenToNotify,
} from "./when-to-notify";

type Loaded = OrgSettingsView & {
  canManage: boolean;
  viewerUserId: string;
};

const ALERTS_DESCRIPTION =
  "Tells your team when a workflow that runs on its own keeps failing: by default, an email to the owners after 5 failed runs in a row. Scheduled runs that do not start are reported too.";

type PutResult = { ok: true; body: Loaded } | { ok: false; error: string };

/** The tap targets below sm stay at least 44px tall. */
const SUMMARY_CLASS =
  "flex min-h-11 cursor-pointer list-none items-center gap-1 text-muted-foreground text-xs hover:text-foreground sm:min-h-0";

function savedChannelsPayload(channels: ChannelView[]): ChannelPayload[] {
  return channels.map((c) => channelPayload(draftFromView(c)));
}

/** The settings exactly as last saved: the base every card's Save starts from. */
function basePayload(saved: Loaded): Record<string, unknown> {
  return {
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

/** The only working channel when nobody can be emailed, so a backup can be suggested. */
function soleWorkingMethod(data: Loaded): string | null {
  const emailable = data.members.some(
    (m) => m.reachable && data.recipientUserIds.includes(m.userId)
  );
  const working = data.channels.filter((c) => !c.pausedAt);
  if (emailable || working.length !== 1) {
    return null;
  }
  const [only] = working;
  return channelLabel(only.kind, only.destination, only.connectionName);
}

/** The pause in force, if it has not run out yet. */
function activePause(data: Loaded): OrgSettingsView["pause"] {
  const pause = data.pause;
  return pause && new Date(pause.until).getTime() > Date.now() ? pause : null;
}

function LoadingCards(): React.ReactElement {
  return (
    <>
      <SettingsCard title="When to notify">
        <FormSkeleton rows={4} />
      </SettingsCard>
      <SettingsCard title="How to notify">
        <FormSkeleton rows={4} />
      </SettingsCard>
    </>
  );
}

/**
 * The Alerts settings page: pause, failing now, the rules every method
 * follows, one card per method, and the history. Each part saves on its own,
 * on top of what was last saved, so an unsaved edit elsewhere is never sent.
 */
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
  // Saves run one after another, each on top of the one before.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const url = `/api/organizations/${encodeURIComponent(organizationId ?? "")}/failure-alerts`;

  const accept = useCallback((body: Loaded): void => {
    savedRef.current = body;
    setData(body);
    setCards((current) => reconcile(current, body));
  }, []);

  const load = useCallback(
    async (isActive: () => boolean = () => true): Promise<void> => {
      setLoadFailed(false);
      try {
        const body = await fetchView<Loaded>(url);
        if (!isActive()) {
          return;
        }
        accept(body);
        setRules(rulesDraftFrom(body));
        setRecipients([...body.recipientUserIds]);
      } catch {
        if (isActive()) {
          setLoadFailed(true);
        }
      }
    },
    [accept, url]
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
          return { ok: false, error: "The settings are still loading." };
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
              error: body.error ?? `Could not save (HTTP ${res.status}).`,
            };
          }
          return { ok: true, body };
        } catch {
          return {
            ok: false,
            error:
              "Could not reach KeeperHub. Check your connection and try again.",
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
              Could not load the failure notification settings.
              <Button
                className="h-auto px-0 text-xs"
                onClick={() => load()}
                type="button"
                variant="link"
              >
                Retry
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

  const orgId = organizationId ?? "";
  const canManage = data.canManage;
  const pause = activePause(data);
  const singleMethod = soleWorkingMethod(data);

  const pauseAlerts = async (body: {
    until: string;
    reason?: string;
  }): Promise<string | null> => {
    const result = await send("PUT", "/pause", () => body);
    if (!result.ok) {
      return result.error;
    }
    accept(result.body);
    setPausing(false);
    return null;
  };

  const resumeAlerts = async (): Promise<string | null> => {
    const result = await send("DELETE", "/pause", null);
    if (!result.ok) {
      return result.error;
    }
    accept(result.body);
    return null;
  };

  const saveRules = async (): Promise<string | null> => {
    const draft = rules;
    const result = await put((saved) => ({
      ...basePayload(saved),
      threshold: Number(draft.threshold),
      timeLimitMinutes: draft.timeLimitMinutes,
      remindDaily: draft.remindDaily,
      notifyRecovery: draft.notifyRecovery,
    }));
    if (!result.ok) {
      return result.error;
    }
    accept(result.body);
    setRules(rulesDraftFrom(result.body));
    return null;
  };

  const saveRecipients = async (): Promise<string | null> => {
    const chosen = recipients;
    const result = await put((saved) => ({
      ...basePayload(saved),
      recipientUserIds: chosen,
    }));
    if (!result.ok) {
      return result.error;
    }
    accept(result.body);
    setRecipients([...result.body.recipientUserIds]);
    return null;
  };

  const saveCard = async (key: string): Promise<string | null> => {
    const card = cardsRef.current.find((c) => c.key === key);
    if (!card) {
      return "This method is no longer on the page.";
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
      return result.error;
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
      toast.error(result.error);
    }
  };

  const removeCard = async (key: string, label: string): Promise<void> => {
    const card = cardsRef.current.find((c) => c.key === key);
    if (!card) {
      return;
    }
    const view = card.id
      ? savedRef.current?.channels.find((c) => c.id === card.id)
      : undefined;
    if (!view) {
      setCards((current) => current.filter((c) => c.key !== key));
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
      toast.error(result.error);
      return;
    }
    accept(result.body);
    toast(`${label} removed`, {
      action: { label: "Undo", onClick: () => restore(view, index) },
    });
  };

  return (
    <div
      className="flex flex-col gap-4 md:gap-6"
      data-testid="failure-alerts-settings"
    >
      <SectionHeader
        action={
          canManage && !pause && !pausing ? (
            <Button
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
        description={ALERTS_DESCRIPTION}
        title="Alerts"
      />
      {pause && (
        <AlertsPausedNotice
          canManage={canManage}
          onResume={resumeAlerts}
          pause={pause}
        />
      )}
      {pausing && !pause && (
        <PauseAlertsForm
          onCancel={() => setPausing(false)}
          onPause={pauseAlerts}
        />
      )}
      {data.unreachable && (
        <Notice className="p-3" role="alert" tone="danger">
          Nobody would be told about a failing workflow: nobody chosen for email
          has an address KeeperHub can reach and no other method works. Add an
          email in{" "}
          <Link className="underline" href="/settings/security">
            Account security
          </Link>
          , or add a Telegram, Discord, Slack or PagerDuty method.
        </Notice>
      )}
      {singleMethod && (
        <Notice className="p-3" tone="warning">
          Only {singleMethod} can reach anyone: nobody chosen for email has an
          address KeeperHub can reach. Add a backup method, or an email in{" "}
          <Link className="underline" href="/settings/security">
            Account security
          </Link>
          , so you still hear about failing workflows if {singleMethod} stops
          working.
        </Notice>
      )}
      {data.failingNow.length > 0 && (
        <SettingsCard
          description="Workflows with an alert open right now."
          title="Failing now"
        >
          <ul className="divide-y rounded-md border">
            {data.failingNow.map((w) => (
              <li
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-sm"
                key={w.workflowId}
              >
                <Link
                  className="min-w-0 break-words font-medium underline underline-offset-4"
                  href={`/workflows/${w.workflowId}?tab=runs`}
                >
                  {w.name}
                </Link>
                <span className="text-destructive text-xs">
                  {w.openedBy === "missed"
                    ? `Not running: due ${timeAgo(w.dueAt)}`
                    : `${failedRuns(w.failureCount)} in a row`}
                </span>
              </li>
            ))}
          </ul>
        </SettingsCard>
      )}

      <SettingsCard
        description="These rules apply to every method below."
        title="When to notify"
      >
        <div className="space-y-4">
          <p className="text-muted-foreground text-xs">
            {data.enabled
              ? "On for every workflow that runs on its own. Runs started by hand never count."
              : "Being switched on for organizations in stages; not on here yet. What you set now applies when it is."}
            {canManage
              ? ""
              : " Only owners and admins can change these settings."}
          </p>
          <WhenToNotify
            canManage={canManage}
            draft={rules}
            onChange={setRules}
            onSave={saveRules}
            saved={data}
          />
          {data.customWorkflows.length > 0 && (
            <p className="text-muted-foreground text-xs">
              {data.customWorkflows.length === 1
                ? "1 workflow has its own settings: "
                : `${data.customWorkflows.length} workflows have their own settings: `}
              {data.customWorkflows.map((w, i) => (
                <span key={w.id}>
                  {i > 0 ? ", " : null}
                  <Link
                    className="underline underline-offset-4"
                    href={`/workflows/${w.id}`}
                  >
                    {w.name}
                  </Link>
                </span>
              ))}
            </p>
          )}
        </div>
      </SettingsCard>

      <SettingsCard
        action={<MessagePreviewDialog organizationId={orgId} />}
        description="Each method saves on its own. Saving checks that it can receive notifications, and every saved method is checked again each day."
        title="How to notify"
      >
        <div className="space-y-4" data-testid="failure-alerts-methods">
          <ul className="space-y-3">
            <EmailMethodCard
              canManage={canManage}
              emailUsage={data.emailUsage}
              members={data.members}
              onChange={setRecipients}
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
                onChange={(next) =>
                  setCards((current) =>
                    current.map((c) => (c.key === next.key ? next : c))
                  )
                }
                onConnectionsChanged={refresh}
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
              onClick={() =>
                setCards((current) => [
                  ...current,
                  newMethodDraft(data.connections),
                ])
              }
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
                A method that stops working is paused and you are told once.
                Every method is also checked quietly every day, without sending
                anything.
              </li>
              <li>
                Only connections shared with the whole organization can be used.
              </li>
            </ul>
          </details>
        </div>
      </SettingsCard>

      <SettingsCard
        description="What was sent, where, and whether it arrived."
        title="Recent notifications"
      >
        <NotificationHistory organizationId={orgId} />
      </SettingsCard>
    </div>
  );
}
