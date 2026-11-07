"use client";

import { ChevronRight } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  EmptyState,
  SectionHeader,
  SettingsCard,
} from "@/components/settings/hub/section";
import { FormSkeleton } from "@/components/settings/hub/skeletons";
import { Button } from "@/components/ui/button";
import { Notice, WARNING_TEXT } from "@/components/ui/notice";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSession } from "@/lib/auth-client";
import { invalidateNotificationStatus } from "@/lib/hooks/use-notifications";
import type {
  ChannelView,
  OrgSettingsView,
} from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";
import { AlertsHealth, statusCardClass } from "./alerts-status";
import { fetchView, ViewError } from "./api";
import { AddMethodButton } from "./channel-list-editor";
import { CustomWorkflowsList } from "./custom-workflows";
import { describeRule } from "./format";
import { memberLabel } from "./member-label";
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
  METHODS_FULL,
  newMethodDraft,
  restoreMethod,
  sameTarget,
} from "./method-drafts";
import { NotificationHistory } from "./notification-history";
import { AlertsStateBody, AlertsSwitch, PauseAlertsForm } from "./pause-alerts";
import {
  NETWORK_REFUSAL,
  refusalFrom,
  SaveError,
  type SaveRefusal,
} from "./save-state";
import { UnsavedChangesGuard } from "./unsaved-guard";
import {
  isValidThreshold,
  type RulesDraft,
  rebaseRules,
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

/** Returned by a save's payload builder to refuse without sending. */
class RefusedSave {
  readonly refusal: SaveRefusal;
  constructor(refusal: SaveRefusal) {
    this.refusal = refusal;
  }
}

type Payload = Record<string, unknown> | RefusedSave;

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

/** The settings exactly as last saved: the base the page's Save writes over. */
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

/** Rules and email recipients save this long after the last change. */
const AUTOSAVE_MS = 1200;

const TABS = ["overview", "setup", "sent"] as const;
type Tab = (typeof TABS)[number];

/** A Settings search hit (?highlight=<card>) opens the tab holding that card. */
const TAB_OF_CARD: Record<string, Tab> = {
  status: "overview",
  "needs-attention": "overview",
  "who-gets-alerts": "setup",
  "when-to-alert": "setup",
  "sent-alerts": "sent",
};

function isTab(value: string | null): value is Tab {
  return TABS.includes(value as Tab);
}

type AutoSave =
  | { state: "idle" | "saving" | "saved" }
  | { state: "error"; refusal: SaveRefusal };

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** "Saving…", "Saved", or "Not saved" with a retry, where a card's Save button would be. */
function AutoSaveStatus({
  status,
  testId,
  onRetry,
  blocked,
}: {
  status: AutoSave;
  testId: string;
  onRetry: () => void;
  /** Why the current edit cannot save; outranks an earlier "Saved". */
  blocked?: string | null;
}): React.ReactElement | null {
  if (blocked) {
    return (
      <span
        className={cn("text-xs", WARNING_TEXT)}
        data-state="blocked"
        data-testid={testId}
        role="status"
      >
        Not saved: {blocked}
      </span>
    );
  }
  if (status.state === "idle") {
    return null;
  }
  const text = {
    saving: "Saving…",
    saved: "Saved",
    error: "Not saved",
  }[status.state];
  return (
    <span
      className={
        status.state === "error"
          ? "font-medium text-destructive text-xs"
          : "text-muted-foreground text-xs"
      }
      data-state={status.state}
      data-testid={testId}
      role="status"
    >
      {text}
      {status.state === "error" && status.refusal.retryable && (
        <Button
          className="ml-2 h-auto px-0 text-xs"
          data-testid={`${testId}-retry`}
          onClick={onRetry}
          type="button"
          variant="link"
        >
          Try again
        </Button>
      )}
    </span>
  );
}

function LoadingCards(): React.ReactElement {
  return (
    <>
      <SettingsCard
        description="Pause alerts for maintenance, or see who paused them."
        title="Status"
      >
        <FormSkeleton rows={2} />
      </SettingsCard>
      <SettingsCard title="Needs attention">
        <FormSkeleton rows={3} />
      </SettingsCard>
    </>
  );
}

/**
 * The Alerts settings page, in three tabs. Rules and email recipients save
 * themselves; each method is checked and saved on its own card.
 */
export function OrgFailureAlertsSection({
  organizationId,
}: {
  organizationId: string | null;
}): React.ReactElement {
  const { data: session } = useSession();
  const [data, setData] = useState<Loaded | null>(null);
  // "missing": the GET answered 404 (alerts are off for the org).
  const [loadFailed, setLoadFailed] = useState<false | "missing" | "error">(
    false
  );
  const [rules, setRules] = useState<RulesDraft | null>(null);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [cards, setCards] = useState<DraftChannel[]>([]);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [rulesSave, setRulesSave] = useState<AutoSave>({ state: "idle" });
  const [emailSave, setEmailSave] = useState<AutoSave>({ state: "idle" });
  const [sentTotal, setSentTotal] = useState<number | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const highlight = searchParams.get("highlight");
  const tab: Tab = isTab(tabParam)
    ? tabParam
    : (highlight && TAB_OF_CARD[highlight]) || "overview";
  const workflowFilter = searchParams.get("workflow");
  const savedRef = useRef<Loaded | null>(null);
  // The latest drafts and save functions, for the autosave timers.
  const rulesRef = useRef<RulesDraft | null>(null);
  rulesRef.current = rules;
  const recipientsRef = useRef<string[]>([]);
  recipientsRef.current = recipients;
  const autosaveRef = useRef<{
    rules: () => Promise<void>;
    recipients: () => Promise<void>;
  } | null>(null);
  const cardsRef = useRef<DraftChannel[]>([]);
  cardsRef.current = cards;
  const methodsRef = useRef<HTMLUListElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  // Saves run one after another, each on top of the one before.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  // The drafts already queued, so a re-armed timer does not send them twice.
  const queuedRef = useRef<{ rules: unknown; recipients: unknown }>({
    rules: null,
    recipients: null,
  });
  const url = `/api/organizations/${encodeURIComponent(organizationId ?? "")}/failure-alerts`;

  /** A newer saved body: unedited drafts follow it; the part just sent waits for its own save. */
  const accept = useCallback(
    (body: Loaded, sent: "rules" | "recipients" | null = null): void => {
      const before = savedRef.current;
      // A read that left before a newer save must not roll the page back.
      if (before && body.version < before.version) {
        return;
      }
      savedRef.current = body;
      setData(body);
      setCards((current) => reconcile(current, body));
      if (!before) {
        return;
      }
      if (sent !== "rules") {
        setRules((current) =>
          current ? rebaseRules(current, before, body) : current
        );
      }
      if (sent !== "recipients") {
        setRecipients((current) =>
          sameIds(current, before.recipientUserIds)
            ? [...body.recipientUserIds]
            : current
        );
      }
    },
    []
  );

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
      } catch (error) {
        if (isActive()) {
          setLoadFailed(
            error instanceof ViewError && error.status === 404
              ? "missing"
              : "error"
          );
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

  // Rules save themselves a moment after the last change, once valid.
  useEffect(() => {
    if (
      !(
        rules &&
        data?.canManage &&
        rulesDirty(rules, data) &&
        isValidThreshold(rules.threshold)
      )
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      autosaveRef.current?.rules().catch(() => undefined);
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [rules, data]);

  // An invalid edit is not saved, so an earlier "saved" toast must not linger.
  const rulesInvalid = Boolean(rules && !isValidThreshold(rules.threshold));
  useEffect(() => {
    if (rulesInvalid) {
      toast.dismiss("failure-alerts-rules-saved");
    }
  }, [rulesInvalid]);

  // So do the people email goes to; at least one must stay chosen.
  useEffect(() => {
    if (!data?.canManage || recipients.length === 0) {
      return;
    }
    if (sameIds(recipients, data.recipientUserIds)) {
      return;
    }
    const timer = window.setTimeout(() => {
      autosaveRef.current?.recipients().catch(() => undefined);
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [recipients, data]);

  // How many alerts were sent, for the Sent alerts tab's label.
  useEffect(() => {
    if (!organizationId) {
      return;
    }
    let active = true;
    fetch(`${url}/history?page=1&limit=1&scope=alerts`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { total?: number } | null) => {
        if (active && typeof body?.total === "number") {
          setSentTotal(body.total);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [organizationId, url]);

  const goTo = useCallback(
    (next: Tab, extra: Record<string, string> = {}): void => {
      const params = new URLSearchParams({ tab: next, ...extra });
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router]
  );

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
      build: ((saved: Loaded) => Payload) | null
    ): Promise<PutResult> => {
      const run = async (): Promise<PutResult> => {
        const saved = savedRef.current;
        if (!saved) {
          return {
            ok: false,
            refusal: { message: "The settings are still loading." },
          };
        }
        const payload = build?.(saved);
        if (payload instanceof RefusedSave) {
          return { ok: false, refusal: payload.refusal };
        }
        try {
          const res = await fetch(`${url}${path}`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: payload ? JSON.stringify(payload) : undefined,
          });
          const body = (await res.json().catch(() => ({}))) as Loaded & {
            error?: string;
          };
          if (!res.ok) {
            return { ok: false, refusal: refusalFrom(res.status, body.error) };
          }
          // The banner and nav read health and unreachable state from status.
          invalidateNotificationStatus(organizationId ?? undefined);
          return { ok: true, body };
        } catch {
          return { ok: false, refusal: NETWORK_REFUSAL };
        }
      };
      const next = queueRef.current.then(run);
      queueRef.current = next;
      return next;
    },
    [organizationId, url]
  );

  const put = useCallback(
    (build: (saved: Loaded) => Payload): Promise<PutResult> =>
      send("PUT", "", build),
    [send]
  );

  // Outside the rollout the settings GET answers 404.
  if (loadFailed === "missing" || data?.enabled === false) {
    return (
      <div data-testid="failure-alerts-unavailable">
        <SectionHeader description={ALERTS_DESCRIPTION} title="Alerts" wide />
        <SettingsCard className="mt-4 md:mt-6">
          <EmptyState>
            Alerts are not available for this organization yet.
          </EmptyState>
        </SettingsCard>
      </div>
    );
  }

  if (!(data && rules)) {
    const header = (
      <SectionHeader description={ALERTS_DESCRIPTION} title="Alerts" wide />
    );
    if (loadFailed === "error") {
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

  const orgId = organizationId ?? "";
  const canManage = data.canManage;
  const rulesBlocked =
    canManage &&
    rules &&
    rulesDirty(rules, data) &&
    !isValidThreshold(rules.threshold)
      ? "fix the number of failed runs"
      : null;
  const pause =
    data.pause && new Date(data.pause.until).getTime() > Date.now()
      ? data.pause
      : null;
  const emailReaches = data.members.some(
    (m) => m.reachable && data.recipientUserIds.includes(m.userId)
  );
  const recipientsDirty = !sameIds(recipients, data.recipientUserIds);
  // Leaving warns only about what would be lost: unsaved methods, or an
  // autosave not sent yet.
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

  /** The switch turned on: resume now, saying so if it could not. */
  const runResume = (): void => {
    setResuming(true);
    setResumeError(null);
    resumeAlerts()
      .then((error) => setResumeError(error))
      .finally(() => setResuming(false));
  };

  const resumeAlerts = async (): Promise<string | null> => {
    const result = await send("DELETE", "/pause", null);
    if (!result.ok) {
      return result.refusal.message;
    }
    accept(result.body);
    return null;
  };

  const saveRules = async (): Promise<void> => {
    const draft = rules;
    if (queuedRef.current.rules === draft) {
      return;
    }
    queuedRef.current.rules = draft;
    const before = rulesDraftFrom(data);
    setRulesSave({ state: "saving" });
    const result = await put((saved) => ({
      ...basePayload(saved),
      threshold: Number(draft.threshold),
      timeLimitMinutes: draft.timeLimitMinutes,
      remindDaily: draft.remindDaily,
      notifyRecovery: draft.notifyRecovery,
    }));
    if (queuedRef.current.rules === draft) {
      queuedRef.current.rules = null;
    }
    if (!result.ok) {
      setRulesSave({ state: "error", refusal: result.refusal });
      return;
    }
    accept(result.body, "rules");
    // An edit made while saving stays on screen and saves next.
    if (rulesRef.current === draft) {
      setRules(rulesDraftFrom(result.body));
    }
    setRulesSave({ state: "saved" });
    toast.success("Alert rules saved", {
      id: "failure-alerts-rules-saved",
      action: { label: "Undo", onClick: () => setRules(before) },
    });
  };

  const saveRecipients = async (): Promise<void> => {
    const chosen = recipients;
    if (queuedRef.current.recipients === chosen) {
      return;
    }
    queuedRef.current.recipients = chosen;
    const before = [...data.recipientUserIds];
    setEmailSave({ state: "saving" });
    const result = await put((saved) => ({
      ...basePayload(saved),
      recipientUserIds: chosen,
    }));
    if (queuedRef.current.recipients === chosen) {
      queuedRef.current.recipients = null;
    }
    if (!result.ok) {
      setEmailSave({ state: "error", refusal: result.refusal });
      return;
    }
    accept(result.body, "recipients");
    if (recipientsRef.current === chosen) {
      setRecipients([...result.body.recipientUserIds]);
    }
    setEmailSave({ state: "saved" });
    toast.success("Email recipients saved", {
      id: "failure-alerts-email-saved",
      action: { label: "Undo", onClick: () => setRecipients(before) },
    });
  };
  autosaveRef.current = { rules: saveRules, recipients: saveRecipients };

  /** One method, checked with its provider and saved; the rest stay as saved. */
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
              stoppedReason: undefined,
            }
          : c
      )
    );
    accept(result.body);
    return null;
  };

  const restore = async (view: ChannelView, index: number): Promise<void> => {
    const result = await put((saved) => {
      // A stopped channel comes back stopped, not live.
      const item: ChannelPayload = {
        kind: view.kind,
        integrationId: view.integrationId,
        destination: view.destination,
        role: view.role,
        stoppedReason: view.stoppedAt
          ? (view.stoppedReason ?? "It stopped working.")
          : undefined,
      };
      const channels = savedChannelsPayload(saved.channels);
      // Unsaved cards count too, so the page never shows more than the cap.
      const unsaved = cardsRef.current.filter((c) => !c.id).length;
      const next = restoreMethod(channels, item, index, unsaved);
      if (next === "full") {
        return new RefusedSave({ message: METHODS_FULL });
      }
      return { ...basePayload(saved), channels: next ?? channels };
    });
    if (result.ok) {
      accept(result.body);
    } else {
      toast.error(result.refusal.message);
    }
  };

  /** Removing a saved method takes effect at once; Undo puts it back. */
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

  const disablingWorkflows = data.customWorkflows.filter(
    (w) => w.disableWorkflow
  ).length;

  return (
    <div
      className="flex flex-col gap-4 md:gap-6"
      data-testid="failure-alerts-settings"
    >
      <UnsavedChangesGuard
        backFallback={`/settings/${encodeURIComponent(orgId)}`}
        dirty={anyDirty}
      />
      <SectionHeader
        description={
          <>
            <span data-testid="failure-alerts-rule-sentence">
              {ruleSentence(data)}
            </span>
            <span
              className="mt-1 block"
              data-testid="failure-alerts-scope-note"
            >
              Messages your workflows send as steps are not affected. A workflow
              can have its own alert rules in its Properties.
            </span>
            {!canManage && (
              <span className="mt-1 block">
                Only owners and admins can change alert settings.
              </span>
            )}
          </>
        }
        title="Alerts"
        wide
      />

      <Tabs
        className="gap-4 md:gap-6"
        onValueChange={(next) => {
          if (isTab(next)) {
            goTo(next);
          }
        }}
        value={tab}
      >
        <TabsList
          aria-label="Alerts sections"
          className="grid h-10 w-full grid-cols-3 sm:w-fit"
          data-testid="failure-alerts-tabs"
        >
          <TabsTrigger
            data-testid="failure-alerts-tab-overview"
            value="overview"
          >
            Overview
          </TabsTrigger>
          <TabsTrigger data-testid="failure-alerts-tab-setup" value="setup">
            Setup
          </TabsTrigger>
          <TabsTrigger data-testid="failure-alerts-tab-sent" value="sent">
            Sent alerts
            {sentTotal !== null && (
              <span className="text-muted-foreground text-xs tabular-nums">
                {sentTotal}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent className="flex flex-col gap-4 md:gap-6" value="overview">
          <SettingsCard
            action={
              <AlertsSwitch
                busy={resuming || pausing}
                canManage={canManage}
                onPause={() => setPausing(true)}
                onResume={runResume}
                paused={Boolean(pause)}
              />
            }
            className={statusCardClass(data)}
            description="Pause alerts for maintenance, or see who paused them."
            title="Status"
          >
            <div className="space-y-4">
              <AlertsStateBody
                canManage={canManage}
                disablingWorkflows={disablingWorkflows}
                error={resumeError}
                onExtend={() => setPausing(true)}
                pause={pause}
              />
              {pausing && (
                <PauseAlertsForm
                  disablingWorkflows={disablingWorkflows}
                  onCancel={() => setPausing(false)}
                  onPause={pauseAlerts}
                />
              )}
            </div>
          </SettingsCard>
          <SettingsCard
            description="Failing workflows and anything stopping alerts from arriving."
            title="Needs attention"
          >
            <AlertsHealth
              canManage={canManage}
              data={data}
              onChanged={() => {
                refresh().catch(() => undefined);
              }}
              onGoToSetup={() => goTo("setup")}
              viewerUserId={session?.user?.id}
            />
          </SettingsCard>
        </TabsContent>

        <TabsContent className="flex flex-col gap-4 md:gap-6" value="setup">
          <SettingsCard
            action={
              <AutoSaveStatus
                blocked={
                  canManage && recipients.length === 0
                    ? "choose at least one person"
                    : null
                }
                onRetry={() => {
                  saveRecipients().catch(() => undefined);
                }}
                status={emailSave}
                testId="failure-alerts-email-autosave"
              />
            }
            description="Email, chat and PagerDuty. Each is checked when you save it, and every day."
            title="Who gets alerts"
          >
            <div className="space-y-4" data-testid="failure-alerts-methods">
              {emailSave.state === "error" && (
                <SaveError error={emailSave.refusal} onReload={reload} />
              )}
              <ul
                aria-label="Alert methods"
                className="space-y-3"
                ref={methodsRef}
              >
                <EmailMethodCard
                  canManage={canManage}
                  emailUsage={data.emailUsage}
                  members={data.members}
                  onChange={setRecipients}
                  onReload={reload}
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
                <AddMethodButton
                  buttonRef={addRef}
                  count={cards.length}
                  onClick={addMethod}
                  testId="failure-alerts-add-method"
                />
              )}
              <details className="group text-xs">
                <summary className={SUMMARY_CLASS}>
                  <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                  How delivery works
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-8 text-muted-foreground">
                  <li>
                    Each alert goes out once per failing streak, not on every
                    failed run. A workflow that fails again within 30 minutes of
                    recovering continues the same alert, and the recovery is
                    sent 30 minutes after it first succeeds, if it has not
                    failed again.
                  </li>
                  <li>
                    If email or chat cannot deliver for 15 minutes, or PagerDuty
                    for 2, the alert goes to your backup methods and to email,
                    saying what failed. Retries continue for an hour; a message
                    still not sent an hour after it was due is dropped. A
                    PagerDuty resolve keeps trying for 24 hours.
                  </li>
                  <li>
                    A method that stops working gets nothing until it works, and
                    everyone is told once. It is checked again every day and
                    turns back on by itself when it works, except Slack, which
                    turns back on only when a test passes.
                  </li>
                  <li>
                    Only connections shared with the whole organization can be
                    used.
                  </li>
                </ul>
              </details>
            </div>
          </SettingsCard>

          <SettingsCard
            action={
              <AutoSaveStatus
                blocked={rulesBlocked}
                onRetry={() => {
                  saveRules().catch(() => undefined);
                }}
                status={rulesSave}
                testId="failure-alerts-rules-autosave"
              />
            }
            description="How many failures it takes before people are told."
            title="When to alert"
          >
            <div className="space-y-4">
              {rulesSave.state === "error" && (
                <SaveError error={rulesSave.refusal} onReload={reload} />
              )}
              <WhenToNotify
                canManage={canManage}
                draft={rules}
                onChange={setRules}
                saved={data}
              />
              {data.customWorkflows.length > 0 && (
                <div
                  className="space-y-2 border-t pt-4"
                  data-testid="failure-alerts-exceptions"
                >
                  <h3 className="font-medium text-sm">
                    Workflows with their own rules (
                    {data.customWorkflows.length})
                  </h3>
                  <p className="text-muted-foreground text-xs">
                    These do not follow the rules above. Change them in each
                    workflow's Properties.
                  </p>
                  <CustomWorkflowsList
                    paused={data.pausedWorkflows}
                    workflows={data.customWorkflows}
                  />
                </div>
              )}
            </div>
          </SettingsCard>
        </TabsContent>

        <TabsContent className="flex flex-col gap-4 md:gap-6" value="sent">
          <SettingsCard
            description="Every message KeeperHub sent, where it went, and whether it arrived."
            title="Sent alerts"
          >
            <NotificationHistory
              onClearWorkflow={() => goTo("sent")}
              onTotal={setSentTotal}
              organizationId={orgId}
              workflowId={workflowFilter ?? undefined}
            />
          </SettingsCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
