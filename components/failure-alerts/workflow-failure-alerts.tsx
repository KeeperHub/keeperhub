"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { BellOff, Check, Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { timeAgo } from "@/components/settings/hub/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import { Label } from "@/components/ui/label";
import { Notice, WARNING_TEXT } from "@/components/ui/notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  invalidateNotificationStatus,
  useAlertsEnabled,
} from "@/lib/hooks/use-notifications";
import { useOrganization } from "@/lib/hooks/use-organization";
import {
  MAX_MUTE_DAYS,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  REFUSALS_STOPPED_MS,
  TIME_LIMIT_OPTIONS_MINUTES,
} from "@/lib/notifications/failure-alerts/constants";
import {
  methodText,
  refusalFixHref,
  refusalFixLink,
  type WorkflowAlertView,
} from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";
import {
  extraUnsavedAtom,
  registerExtraSave,
} from "@/lib/workflow/extra-saves";
import {
  isWorkflowEnabled,
  propertiesPanelActiveTabAtom,
  workflowEnableToggleAtom,
} from "@/lib/workflow/store";
import { fetchView } from "./api";
import { ChannelListEditor } from "./channel-list-editor";
import { focusInPlace } from "./focus-in-place";
import {
  FUNDS_RULE,
  failedRuns,
  formatWhen,
  incidentTitle,
  timeLimitLabel,
  toLocalInput,
} from "./format";
import { memberLabel } from "./member-label";
import {
  channelsPayload,
  type DraftChannel,
  draftsFromViews,
  needsDestination,
  nextKey,
} from "./method-drafts";
import { NotificationHistory } from "./notification-history";
import {
  NETWORK_REFUSAL,
  refusalFrom,
  SaveError,
  type SaveRefusal,
} from "./save-state";

type Loaded = WorkflowAlertView & { canManage: boolean };
type Panel = null | "mute";
/** Custom rules save this long after the last edit. */
const AUTOSAVE_MS = 1500;

const HOUR_MS = 60 * 60 * 1000;
// One id for every save toast, so "muted" then "back on" replace each other
// instead of stacking over the panel's buttons.
const SAVE_TOAST = "workflow-failure-alerts-save";

/** The first thing to focus when a panel opens. */
const FOCUSABLE = "button:not([disabled]), input:not([disabled])";

/** Footer links stay at least 44px tall below sm, for a thumb. */
const FOOTER_LINK =
  "inline-flex min-h-11 items-center text-foreground underline underline-offset-4 sm:min-h-0";
/** Panel buttons wrap their label instead of overflowing a narrow panel. */
const WRAP_BUTTON = "h-auto min-h-8 min-w-0 max-w-full whitespace-normal";
const MUTE_CHOICES: { id: string; label: string; ms: number | "success" }[] = [
  { id: "1h", label: "1 hour", ms: HOUR_MS },
  { id: "24h", label: "24 hours", ms: 24 * HOUR_MS },
  { id: "7d", label: "7 days", ms: 7 * 24 * HOUR_MS },
  { id: "success", label: "Until it works again", ms: "success" },
];

function describeTimeLimit(minutes: number | null): string {
  return minutes ? ` or ${timeLimitLabel(minutes)} of failing` : "";
}

/** The org rules alone, as the Org rules tab shows them even while this workflow has its own. */
/** The org's alert people, as the org rules show them. */
function orgEmails(view: Loaded): string[] {
  return view.members
    .filter((m) => m.reachable && view.org.recipientUserIds.includes(m.userId))
    .map(memberLabel);
}

/** Rules, Email and Methods as Settings > Alerts lays them out, read-only. */
function RulesView({
  threshold,
  timeLimitMinutes,
  pauseWorkflow,
  emails,
  channels,
}: {
  threshold: number;
  timeLimitMinutes: number | null;
  pauseWorkflow: boolean;
  emails: string[];
  channels: Loaded["org"]["channels"];
}): React.ReactElement {
  return (
    <div className="space-y-4" data-testid="failure-alerts-rules-view">
      <section className="space-y-1.5">
        <h3 className="font-semibold text-sm">Rules</h3>
        <p>
          Alert after <span className="font-semibold">{threshold}</span> failed
          run{threshold === 1 ? "" : "s"} in a row
        </p>
        <p>
          {timeLimitMinutes ? (
            <>
              or when it has been failing for{" "}
              <span className="font-semibold">
                {timeLimitLabel(timeLimitMinutes)}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">No time limit</span>
          )}
        </p>
        {pauseWorkflow && (
          <p className="text-xs">
            Turns this workflow off when it reaches the limit.
          </p>
        )}
      </section>
      <section className="space-y-1.5 border-t pt-3">
        <h3 className="font-semibold text-sm">Email</h3>
        <p className="break-words text-xs">
          {emails.length > 0 ? emails.join(", ") : "Nobody can be emailed."}
        </p>
      </section>
      <section className="space-y-1.5 border-t pt-3">
        <h3 className="font-semibold text-sm">Methods</h3>
        {channels.length > 0 ? (
          <ul className="space-y-1">
            {channels.map((c) => (
              <li
                className="flex min-w-0 items-center gap-1.5 text-xs"
                key={`${c.kind}:${c.destination}:${c.connectionName ?? ""}`}
              >
                <IntegrationIcon
                  className="size-3.5 shrink-0"
                  integration={c.kind}
                />
                <span className="min-w-0 break-words">
                  {methodText(c.kind, c.destination, c.connectionName)}
                  {c.role === "backup" ? " (backup)" : ""}
                  {c.pausedAt ? " (paused)" : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-xs">Email only.</p>
        )}
      </section>
    </div>
  );
}

/** The same last line on both tabs: in use, or a button that makes it so. */
function TabFooter({
  inUse,
  children,
}: {
  inUse: boolean;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
      {inUse ? (
        <span
          className="flex items-center gap-1.5 font-medium text-keeperhub-green-dark text-xs"
          data-testid="failure-alerts-in-use"
        >
          <Check aria-hidden="true" className="size-3.5" />
          Used by this workflow
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">
          Not used by this workflow
        </span>
      )}
      {children}
    </div>
  );
}

/** "1 more failed run" before the alert, for a workflow that turns itself off. */
function runsLeft(view: Loaded): string {
  const left = Math.max(view.effective.threshold - view.status.failures, 1);
  return `${left} more failed run${left === 1 ? "" : "s"}`;
}

type PanelIncident = NonNullable<Loaded["status"]["incident"]>;

/** Who heard about it. */
function alertLine(incident: PanelIncident): string {
  return incident.deliveredTo.length > 0
    ? `Alert sent ${timeAgo(incident.openedAt)} to ${incident.deliveredTo.join(", ")}.`
    : `Alert queued ${timeAgo(incident.openedAt)}, not delivered yet.`;
}

/** Nothing has tried to run for a day: reminders stopped, and nothing will recover it on its own. */
function refusalsStopped(lastRefusedAt: string | null): boolean {
  return (
    lastRefusedAt !== null &&
    Date.now() - new Date(lastRefusedAt).getTime() >= REFUSALS_STOPPED_MS
  );
}

function isMutedView(view: Loaded): boolean {
  return Boolean(view.override.mutedUntil || view.override.muteUntilSuccess);
}

const ALERTS_NOT_SAVED =
  "The alert rule change was not saved. Open Alerts for this workflow to try again.";
// After the panel closes nothing is kept, so these say what the workflow still uses.
const ALERTS_DROPPED =
  "Your unfinished alert rule change was dropped. This workflow keeps its saved rules.";
const ALERTS_LOST =
  "Your alert rule change could not be saved. This workflow keeps its saved rules.";

/** "Alerts" in a workflow's Properties: the rule, what is failing, mute and change. */
export function WorkflowFailureAlerts({
  workflowId,
  triggerType,
}: {
  workflowId: string;
  /** The trigger as edited, so switching to Manual updates without a save. */
  triggerType: string | undefined;
}): React.ReactElement | null {
  const [view, setView] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [saveError, setSaveError] = useState<SaveRefusal | null>(null);
  const { organization } = useOrganization();
  const alertsEnabled = useAlertsEnabled(organization?.id);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const enableToggle = useAtomValue(workflowEnableToggleAtom);
  const enabled = useAtomValue(isWorkflowEnabled);

  const [threshold, setThreshold] = useState("");
  const [timeLimit, setTimeLimit] = useState("org");
  const [customRecipients, setCustomRecipients] = useState<string[] | null>(
    null
  );
  const [customChannels, setCustomChannels] = useState<DraftChannel[] | null>(
    null
  );
  const [muteDate, setMuteDate] = useState("");
  const [pauseWorkflow, setPauseWorkflow] = useState(false);
  // The tab on screen; the rules in use are marked on their tab.
  const [tab, setTab] = useState<"org" | "custom">("org");
  const panelRef = useRef<HTMLDivElement>(null);
  const muteButtonRef = useRef<HTMLButtonElement>(null);
  // Which button opened the panel, to give focus back to when it closes.
  const openerRef = useRef<Panel>(null);
  // The custom rules as edited, kept current each render for the autosave.
  const autosaveRef = useRef<{
    key: string;
    dirty: boolean;
    ready: boolean;
    save: () => Promise<boolean>;
  } | null>(null);
  const setWorkflowUnsaved = useSetAtom(extraUnsavedAtom);
  // Saves go out one after another, each on the version the last one returned.
  const viewRef = useRef<Loaded | null>(null);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const inFlightRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const draftSaveRef = useRef<{ key: string; done: Promise<boolean> } | null>(
    null
  );
  // The draft "Use org rules" is dropping; nothing may send it after that.
  const droppedKeyRef = useRef<string | null>(null);
  const sourceRef = useRef<string | null>(null);
  // The custom rules as last refused, so the panel offers a retry, not a wait.
  const [failedKey, setFailedKey] = useState<string | null>(null);
  // A failed switch to the org rules is retried by pressing it again, not here.
  const [failedReset, setFailedReset] = useState(false);

  const url = `/api/workflows/${encodeURIComponent(workflowId)}/failure-alerts`;

  const showView = useCallback((next: Loaded) => {
    viewRef.current = next;
    setView(next);
  }, []);

  const apply = useCallback(
    (next: Loaded) => {
      showView(next);
      setFailedKey(null);
      // The tab follows the rules in use only when they change, not on every save.
      if (sourceRef.current !== next.effective.source) {
        sourceRef.current = next.effective.source;
        setTab(next.effective.source === "custom" ? "custom" : "org");
      }
      setThreshold(
        next.override.threshold ? String(next.override.threshold) : ""
      );
      let limit = "org";
      if (next.override.timeLimitMinutes === 0) {
        limit = "off";
      } else if (next.override.timeLimitMinutes) {
        limit = String(next.override.timeLimitMinutes);
      }
      setTimeLimit(limit);
      setCustomRecipients(next.override.recipientUserIds);
      setPauseWorkflow(next.override.pauseWorkflow);
      setCustomChannels(
        next.override.customChannels
          ? draftsFromViews(next.override.channels)
          : null
      );
    },
    [showView]
  );

  const load = useCallback(
    async (isActive: () => boolean = () => true): Promise<void> => {
      setLoadFailed(false);
      try {
        const body = await fetchView<Loaded>(url);
        if (isActive()) {
          apply(body);
        }
      } catch {
        if (isActive()) {
          setLoadFailed(true);
        }
      }
    },
    [apply, url]
  );

  useEffect(() => {
    // No loads until alerts are known to be on for the org.
    if (alertsEnabled !== true) {
      return;
    }
    let active = true;
    load(() => active).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [load, alertsEnabled]);

  useEffect(() => {
    if (panel) {
      focusInPlace(panelRef.current?.querySelector<HTMLElement>(FOCUSABLE));
      return;
    }
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener === "mute") {
      focusInPlace(muteButtonRef.current);
    }
  }, [panel]);

  // Escape closes the mute panel like Cancel; a native listener, so a portalled
  // select's Escape closes only that list.
  useEffect(() => {
    const element = panelRef.current;
    if (!(panel && element && view)) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setSaveError(null);
      setPanel(null);
    };
    element.addEventListener("keydown", onKeyDown);
    return () => element.removeEventListener("keydown", onKeyDown);
  }, [panel, view]);

  // Custom rules save themselves a moment after the last edit, like the rest
  // of the workflow; the toolbar's Save sends them at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the drafts are the trigger; the ref holds what to save
  useEffect(() => {
    const pending = autosaveRef.current;
    setWorkflowUnsaved(pending?.dirty === true);
    if (!pending?.dirty) {
      return;
    }
    if (!pending.ready) {
      return;
    }
    const timer = window.setTimeout(() => {
      timerRef.current = null;
      autosaveRef.current
        ?.save()
        .then((ok) => {
          // The status line can sit below the fold; a failure must be seen.
          if (!ok) {
            toast.error("Alert rules not saved", {
              id: SAVE_TOAST,
              description: "The Alerts section says why, with Try again.",
            });
          }
        })
        .catch(() => undefined);
    }, AUTOSAVE_MS);
    timerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (timerRef.current === timer) {
        timerRef.current = null;
      }
    };
  }, [threshold, timeLimit, customRecipients, customChannels, pauseWorkflow]);

  // Resolves true once the custom rules are saved; an unfinished draft stays
  // unsaved here, and a failed save says so wherever the user is.
  useEffect(
    () =>
      registerExtraSave(async () => {
        const pending = autosaveRef.current;
        if (!pending?.dirty) {
          return true;
        }
        if (!pending.ready) {
          return false;
        }
        const ok = await pending.save();
        if (!ok) {
          toast.error(ALERTS_NOT_SAVED, { id: SAVE_TOAST });
        }
        return ok;
      }),
    []
  );

  // Leaving the panel (another node picked) sends a pending edit at once.
  useEffect(
    () => () => {
      const pending = autosaveRef.current;
      if (!pending?.dirty) {
        return;
      }
      if (!pending.ready) {
        // The panel is gone, so an unfinished edit cannot be kept; say so.
        setWorkflowUnsaved(false);
        toast.error(ALERTS_DROPPED, { id: SAVE_TOAST });
        return;
      }
      pending
        .save()
        .then((ok) => {
          if (!ok) {
            toast.error(ALERTS_LOST, { id: SAVE_TOAST });
          }
        })
        .catch(() => undefined)
        .finally(() => setWorkflowUnsaved(false));
    },
    // A Jotai setter never changes, so this still runs only on unmount.
    [setWorkflowUnsaved]
  );

  const openPanel = (next: Exclude<Panel, null>): void => {
    openerRef.current = next;
    setPanel(next);
  };

  const refreshConnections = useCallback(async () => {
    const res = await fetch(url);
    if (res.ok) {
      const body = (await res.json()) as Loaded;
      const prev = viewRef.current;
      if (prev) {
        showView({ ...prev, connections: body.connections });
      }
    }
  }, [showView, url]);

  // Hidden where alerts are not switched on, and until that is known.
  if (alertsEnabled !== true) {
    return null;
  }

  if (!view) {
    return (
      <div className="space-y-2">
        <Label className="ml-1">Alerts</Label>
        {loadFailed ? (
          <Notice role="alert" tone="danger">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              Could not load alert settings.
              <Button
                className="h-auto px-0 text-xs"
                onClick={() => load()}
                type="button"
                variant="link"
              >
                Try again
              </Button>
            </span>
          </Notice>
        ) : (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <Loader2 className="size-3.5 animate-spin" />
            Loading
          </div>
        )}
      </div>
    );
  }

  const applies = Boolean(triggerType && triggerType !== "Manual");
  const canManage = view.canManage;
  const muted = isMutedView(view);
  const custom = view.effective.source === "custom";
  // Off because its alert turned it off, and not turned back on since.
  const pausedAt = view.status.incident?.workflowPausedAt ?? null;
  const resumedAt = view.status.incident?.workflowResumedAt ?? null;
  const pausedByAlert =
    pausedAt !== null &&
    (resumedAt === null || resumedAt < pausedAt) &&
    !enabled;
  // The fix link the alert carries; none when the workflow cannot run.
  const fix = view.status.incident?.refused
    ? refusalFixLink(view.status.incident.refusedReason)
    : null;
  const thresholdInvalid =
    threshold.trim() !== "" &&
    !(
      Number.isInteger(Number(threshold)) &&
      Number(threshold) >= MIN_THRESHOLD &&
      Number(threshold) <= MAX_THRESHOLD
    );

  /** The override as stored, so a mute change keeps the custom fields. */
  const storedOverride = (latest: Loaded): Record<string, unknown> => ({
    threshold: latest.override.threshold,
    timeLimitMinutes: latest.override.timeLimitMinutes,
    recipientUserIds: latest.override.recipientUserIds,
    customChannels: latest.override.customChannels,
    channels: channelsPayload(draftsFromViews(latest.override.channels)),
    pauseWorkflow: latest.override.pauseWorkflow,
  });
  const orgPause =
    view.org.pause && new Date(view.org.pause.until).getTime() > Date.now()
      ? view.org.pause
      : null;

  const cancelAutosave = (): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  /** Queues a save; the body is built from the view as the last save left it. */
  const put = (
    body: (latest: Loaded) => Record<string, unknown>,
    done: string | null,
    options: {
      /** The draft sent; its answer resets the drafts only if still current. */
      sentKey?: string;
      /** Reset the drafts to the answer (switching which rules are in use). */
      reset?: boolean;
    } = {}
  ): Promise<boolean> => {
    inFlightRef.current += 1;
    setSaving(true);
    setSaveError(null);
    const run = async (): Promise<boolean> => {
      const latest = viewRef.current ?? view;
      try {
        const res = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body(latest), version: latest.version }),
        });
        const data = (await res.json().catch(() => ({}))) as Loaded & {
          error?: string;
        };
        if (!res.ok) {
          setSaveError(refusalFrom(res.status, data.error));
          return false;
        }
        // An edit made while this was saving stays on screen and saves next.
        const current = autosaveRef.current;
        const keepDrafts =
          options.sentKey === undefined
            ? !options.reset && current?.dirty === true
            : options.sentKey !== current?.key;
        if (keepDrafts) {
          showView(data);
        } else {
          apply(data);
        }
        invalidateNotificationStatus(organization?.id);
        if (done) {
          toast.success(done, { id: SAVE_TOAST });
        }
        return true;
      } catch {
        setSaveError(NETWORK_REFUSAL);
        return false;
      } finally {
        inFlightRef.current -= 1;
        if (inFlightRef.current === 0) {
          setSaving(false);
        }
      }
    };
    const next = queueRef.current.then(run);
    queueRef.current = next;
    return next;
  };

  const mute = async (choice: number | "success" | "date"): Promise<void> => {
    let mutedUntil: string | null = null;
    if (choice === "date") {
      if (!muteDate) {
        toast.error("Pick when the mute ends.");
        return;
      }
      mutedUntil = new Date(muteDate).toISOString();
    } else if (choice !== "success") {
      mutedUntil = new Date(Date.now() + choice).toISOString();
    }
    sendPendingDraft();
    const ok = await put(
      (latest) => ({
        ...storedOverride(latest),
        mutedUntil,
        muteUntilSuccess: choice === "success",
      }),
      "Alerts muted for this workflow"
    );
    if (ok) {
      setPanel(null);
    }
  };

  const unmute = async (): Promise<void> => {
    sendPendingDraft();
    await put(storedOverride, "Alerts back on for this workflow");
  };

  const timeLimitValue = (): number | null => {
    if (timeLimit === "off") {
      return 0;
    }
    return timeLimit === "org" ? null : Number(timeLimit);
  };
  /** The custom rules as edited, in the shape the save takes. */
  const draftRules = {
    threshold: threshold.trim() ? Number(threshold) : null,
    timeLimitMinutes: timeLimitValue(),
    recipientUserIds: customRecipients,
    customChannels: customChannels !== null,
    channels: customChannels ? channelsPayload(customChannels) : [],
    pauseWorkflow,
  };
  const savedRules = {
    threshold: view.override.threshold,
    timeLimitMinutes: view.override.timeLimitMinutes,
    recipientUserIds: view.override.recipientUserIds,
    customChannels: view.override.customChannels,
    channels: view.override.customChannels
      ? channelsPayload(draftsFromViews(view.override.channels))
      : [],
    pauseWorkflow: view.override.pauseWorkflow,
  };
  const draftKey = JSON.stringify(draftRules);
  const rulesDirty =
    custom && canManage && draftKey !== JSON.stringify(savedRules);
  // A new method waits until it has a connection (and a chat, channel or service).
  const methodsReady = (customChannels ?? []).every(
    (c) =>
      c.integrationId && (!needsDestination(c.kind) || c.destination.trim())
  );
  const rulesReady = !thresholdInvalid && methodsReady;

  const saveDraft = (): Promise<boolean> => {
    cancelAutosave();
    const key = draftKey;
    if (droppedKeyRef.current === key) {
      return Promise.resolve(true);
    }
    // The timer and the toolbar Save can ask for the same draft; send it once.
    if (draftSaveRef.current?.key === key) {
      return draftSaveRef.current.done;
    }
    const rules = draftRules;
    const done = put(
      (latest) => ({
        ...rules,
        mutedUntil: latest.override.mutedUntil,
        muteUntilSuccess: latest.override.muteUntilSuccess,
      }),
      null,
      { sentKey: key }
    ).then((ok) => {
      if (draftSaveRef.current?.key === key) {
        draftSaveRef.current = null;
      }
      setFailedKey(ok ? null : key);
      setFailedReset(false);
      if (ok && key === autosaveRef.current?.key) {
        setWorkflowUnsaved(false);
      }
      return ok;
    });
    draftSaveRef.current = { key, done };
    return done;
  };
  autosaveRef.current = {
    key: draftKey,
    dirty: rulesDirty,
    ready: rulesReady,
    save: saveDraft,
  };

  /** Before a mute change, a finished edit goes out first so neither undoes the other. */
  const sendPendingDraft = (): void => {
    if (rulesDirty && rulesReady) {
      saveDraft().catch(() => undefined);
    } else {
      cancelAutosave();
    }
  };

  /** Picking Custom rules saves the org's values as this workflow's own. */
  const switchToCustom = async (): Promise<void> => {
    cancelAutosave();
    await put(
      (latest) => ({
        threshold: latest.org.threshold,
        timeLimitMinutes: latest.org.timeLimitMinutes ?? 0,
        recipientUserIds: null,
        customChannels: false,
        channels: [],
        pauseWorkflow: false,
        mutedUntil: latest.override.mutedUntil,
        muteUntilSuccess: latest.override.muteUntilSuccess,
      }),
      "This workflow now has its own rules",
      { reset: true }
    );
  };

  const followOrgSetting = async (): Promise<void> => {
    // Going back to the org rules drops the custom ones, edits included.
    cancelAutosave();
    const dropped = draftKey;
    droppedKeyRef.current = dropped;
    const ok = await put(
      (latest) => ({
        mutedUntil: latest.override.mutedUntil,
        muteUntilSuccess: latest.override.muteUntilSuccess,
      }),
      "Back on the org rules",
      { reset: true }
    );
    droppedKeyRef.current = null;
    if (ok) {
      setPanel(null);
    } else {
      // Say so on the tab it was pressed on; retrying is pressing it again.
      setFailedKey(dropped);
      setFailedReset(true);
      toast.error(
        "Still on the custom rules: the switch to the org rules was not saved.",
        {
          id: SAVE_TOAST,
        }
      );
    }
  };

  const saveErrorBox = (
    <SaveError
      error={saveError}
      onReload={() => {
        setSaveError(null);
        setPanel(null);
        load().catch(() => undefined);
      }}
    />
  );

  // The tabs say which rules are in use; the badge is for what overrides both.
  let tag: { label: string; className?: string } | null = null;
  if (!applies) {
    tag = { label: "Not used" };
  } else if (muted) {
    tag = { label: "Muted", className: WARNING_TEXT };
  }
  const editing = canManage && custom;
  const chooseTab = (next: string): void => {
    if (next !== "org" && next !== "custom") {
      return;
    }
    setTab(next);
  };
  let autosaveLine = "All changes saved";
  if (saving) {
    autosaveLine = "Saving…";
  } else if (rulesDirty && !rulesReady) {
    autosaveLine = thresholdInvalid
      ? "Not saved: fix the number of failed runs"
      : "Not saved: finish the new method (connection and where to send)";
  } else if (rulesDirty && failedKey === draftKey) {
    autosaveLine = "Not saved";
  } else if (rulesDirty) {
    autosaveLine = "Saving shortly…";
  }
  const saveFailed = rulesDirty && rulesReady && failedKey === draftKey;
  // Only a network or server failure is worth sending again as is.
  const canRetry = saveFailed && !failedReset && saveError?.retryable === true;

  return (
    <div
      className="scroll-mt-20 space-y-3"
      data-muted={muted}
      data-source={custom ? "custom" : "org"}
      data-testid="workflow-failure-alerts"
    >
      <div className="ml-1 flex items-center gap-2">
        <Label>Alerts</Label>
        {tag && (
          <Badge className={tag.className} variant="outline">
            {tag.label}
          </Badge>
        )}
      </div>

      {orgPause && (
        <p
          className="rounded-lg border bg-muted/30 p-3 text-muted-foreground text-xs"
          data-testid="workflow-failure-alerts-org-paused"
        >
          Alerts are paused for the whole organization until{" "}
          {formatWhen(orgPause.until)}
          {orgPause.reason ? `: ${orgPause.reason}` : ""}.
        </p>
      )}

      {!applies && (
        <p className="rounded-lg border border-dashed p-3 text-muted-foreground text-sm">
          Only runs started by hand, so alerts do not apply: you see the result
          yourself. Add a Schedule, Event, Block, Webhook, Transfer or Pyth
          Price trigger to get alerts.
        </p>
      )}

      {applies && view.status.incident && (
        // Muted means someone already knows, so the box stops shouting.
        <Notice
          className="scroll-mt-20 p-3 text-sm"
          tone={muted || pausedByAlert ? "warning" : "danger"}
        >
          <div className="min-w-0 space-y-2 break-words">
            <p className="font-medium">
              {incidentTitle(view.status.incident, pausedByAlert)}
            </p>
            {pausedByAlert && (
              <p className="text-xs">
                KeeperHub turned it off, as set for this workflow. Fix the
                cause, then press Turn back on.
              </p>
            )}
            <p className="text-xs">{alertLine(view.status.incident)}</p>
            {refusalsStopped(view.status.incident.lastRefusedAt) && (
              <p className="text-xs">
                No refused runs since{" "}
                {formatWhen(view.status.incident.lastRefusedAt ?? "")}.
              </p>
            )}
            {view.status.incident.refused ? (
              <p className="break-words font-mono text-xs">
                {view.status.incident.refusedReason ??
                  "No reason was recorded."}
              </p>
            ) : (
              view.status.lastError && (
                <p className="break-words font-mono text-xs">
                  {view.status.lastError}
                </p>
              )
            )}
            <div className="flex flex-wrap gap-2">
              {view.status.incident.openedBy === "funding" && (
                <Button
                  asChild
                  className={WRAP_BUTTON}
                  size="sm"
                  variant="outline"
                >
                  <Link
                    data-testid="failure-alerts-add-funds"
                    href={`/settings/${view.organizationId}/wallets`}
                  >
                    Add funds
                  </Link>
                </Button>
              )}
              {fix && (
                <Button
                  asChild
                  className={WRAP_BUTTON}
                  size="sm"
                  variant="outline"
                >
                  <Link
                    data-testid="failure-alerts-refusal-fix"
                    href={refusalFixHref(view.organizationId, fix)}
                  >
                    {fix.label}
                  </Link>
                </Button>
              )}
              <Button
                className={WRAP_BUTTON}
                onClick={() => setActiveTab("runs")}
                size="sm"
                type="button"
                variant="outline"
              >
                {view.status.incident.refused
                  ? "View runs"
                  : "View failed runs"}
              </Button>
              {enableToggle && enabled && (
                <Button
                  className={WRAP_BUTTON}
                  onClick={() => enableToggle.toggle(false)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Turn workflow off
                </Button>
              )}
              {enableToggle && pausedByAlert && (
                <Button
                  className={WRAP_BUTTON}
                  onClick={() => enableToggle.toggle(true)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Turn back on
                </Button>
              )}
            </div>
          </div>
        </Notice>
      )}

      {applies && !view.status.incident && view.status.failures > 0 && (
        <Notice className="p-3" tone="warning">
          <p className="font-medium text-sm">
            Failing: {failedRuns(view.status.failures)} in a row
          </p>
          <p className="text-foreground">
            {view.status.firstFailedAt
              ? `Started failing ${timeAgo(view.status.firstFailedAt)}. `
              : null}
            {view.override.pauseWorkflow
              ? `${runsLeft(view)} and KeeperHub alerts your team and turns this workflow off.`
              : `The alert goes out at ${failedRuns(view.effective.threshold)}${describeTimeLimit(view.effective.timeLimitMinutes)}.`}
          </p>
        </Notice>
      )}

      {applies && (
        <div className="space-y-3 break-words rounded-lg border bg-muted/20 p-3 text-sm">
          {muted && (
            <p className="flex items-start gap-2">
              <BellOff
                aria-hidden="true"
                className={cn("mt-0.5 size-4 shrink-0", WARNING_TEXT)}
              />
              <span className="min-w-0">
                {view.override.muteUntilSuccess
                  ? "Muted until it works again"
                  : `Muted until ${formatWhen(view.override.mutedUntil ?? "")}`}
                {view.override.mutedBy ? ` by ${view.override.mutedBy}` : ""}.
                {view.override.pauseWorkflow
                  ? " Failures still show in Runs; nobody is told unless KeeperHub turns it off at the limit."
                  : " Failures still show in Runs; nobody is told."}
              </span>
            </p>
          )}
          {/* Manual: a tab changes on click or Enter, never because focus landed on it. */}
          <Tabs activationMode="manual" onValueChange={chooseTab} value={tab}>
            <TabsList
              aria-label="Which rules this workflow follows"
              className="grid h-9 w-full grid-cols-2"
            >
              <TabsTrigger data-testid="failure-alerts-tab-org" value="org">
                Org rules
                {!custom && <Check aria-label="in use" className="size-3.5" />}
              </TabsTrigger>
              <TabsTrigger
                data-testid="failure-alerts-tab-custom"
                value="custom"
              >
                Custom rules
                {custom && <Check aria-label="in use" className="size-3.5" />}
              </TabsTrigger>
            </TabsList>

            <TabsContent className="space-y-4 pt-1" value="org">
              <RulesView
                channels={view.org.channels}
                emails={orgEmails(view)}
                pauseWorkflow={false}
                threshold={view.org.threshold}
                timeLimitMinutes={view.org.timeLimitMinutes}
              />
              <TabFooter inUse={!custom}>
                {custom && canManage ? (
                  <Button
                    className={WRAP_BUTTON}
                    data-testid="failure-alerts-reset"
                    disabled={saving}
                    onClick={followOrgSetting}
                    size="sm"
                    type="button"
                  >
                    Use org rules
                  </Button>
                ) : (
                  <Link
                    className="text-xs underline underline-offset-4"
                    href={`/settings/${view.organizationId}/alerts`}
                  >
                    Change them in Settings
                  </Link>
                )}
              </TabFooter>
            </TabsContent>

            <TabsContent className="space-y-4 pt-1" value="custom">
              {editing ? (
                <div
                  className="space-y-4"
                  data-testid="failure-alerts-custom"
                  ref={panelRef}
                >
                  <section className="space-y-3">
                    <h3 className="font-semibold text-sm">Rules</h3>
                    <div className="flex flex-wrap items-center gap-2">
                      <Label
                        className="font-normal"
                        htmlFor="wf-failure-threshold"
                      >
                        Alert after
                      </Label>
                      <Input
                        aria-describedby={
                          thresholdInvalid
                            ? "wf-failure-threshold-error"
                            : undefined
                        }
                        aria-invalid={thresholdInvalid}
                        className="h-9 w-20"
                        id="wf-failure-threshold"
                        inputMode="numeric"
                        max={MAX_THRESHOLD}
                        min={MIN_THRESHOLD}
                        onChange={(e) => setThreshold(e.target.value)}
                        placeholder={String(view.org.threshold)}
                        type="number"
                        value={threshold}
                      />
                      <span>failed runs in a row</span>
                    </div>
                    {thresholdInvalid && (
                      <p
                        className="text-destructive text-xs"
                        id="wf-failure-threshold-error"
                      >
                        Use a whole number from {MIN_THRESHOLD} to{" "}
                        {MAX_THRESHOLD}, or leave it empty for the org's{" "}
                        {view.org.threshold}.
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <Label className="font-normal" htmlFor="wf-time-limit">
                        or when it has been failing for
                      </Label>
                      <Select onValueChange={setTimeLimit} value={timeLimit}>
                        <SelectTrigger
                          className="h-9 w-36"
                          id="wf-time-limit"
                          size="sm"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="org">
                            {view.org.timeLimitMinutes
                              ? timeLimitLabel(view.org.timeLimitMinutes)
                              : "Off"}{" "}
                            (org)
                          </SelectItem>
                          <SelectItem value="off">Off</SelectItem>
                          {TIME_LIMIT_OPTIONS_MINUTES.map((m) => (
                            <SelectItem key={m} value={String(m)}>
                              {timeLimitLabel(m)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          aria-describedby="wf-pause-workflow-help"
                          checked={pauseWorkflow}
                          id="wf-pause-workflow"
                          onCheckedChange={(checked) =>
                            setPauseWorkflow(checked === true)
                          }
                        />
                        <Label className="text-xs" htmlFor="wf-pause-workflow">
                          Turn this workflow off when it reaches the limit
                        </Label>
                      </div>
                      <p
                        className="pl-6 text-muted-foreground text-xs"
                        id="wf-pause-workflow-help"
                      >
                        Turns it off when it fails that many runs in a row or
                        the wallet runs out of funds; the time limit never turns
                        a workflow off. Errors on KeeperHub's side do not count.
                        To start it again, fix the cause, then press Turn back
                        on.
                      </p>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      Starts from the org's rules. Saved here, they stay as they
                      are even if the org rules change.
                    </p>
                  </section>
                  <section className="space-y-2 border-t pt-3">
                    <h3 className="font-semibold text-sm">Email</h3>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={customRecipients !== null}
                          id="wf-own-recipients"
                          onCheckedChange={(checked) =>
                            setCustomRecipients(
                              checked === true
                                ? [...view.org.recipientUserIds]
                                : null
                            )
                          }
                        />
                        <Label className="text-xs" htmlFor="wf-own-recipients">
                          Email different people
                        </Label>
                      </div>
                      {customRecipients === null ? (
                        <p className="text-muted-foreground text-xs">
                          {view.effective.emails.join(", ") ||
                            "Nobody reachable"}{" "}
                          (org)
                        </p>
                      ) : (
                        <ul className="space-y-1.5">
                          {view.members.map((m) => (
                            <li
                              className="flex items-center gap-2 text-sm"
                              key={m.userId}
                            >
                              <Checkbox
                                checked={customRecipients.includes(m.userId)}
                                disabled={!m.reachable}
                                id={`wf-recipient-${m.userId}`}
                                onCheckedChange={(checked) =>
                                  setCustomRecipients(
                                    checked === true
                                      ? [
                                          ...new Set([
                                            ...customRecipients,
                                            m.userId,
                                          ]),
                                        ]
                                      : customRecipients.filter(
                                          (id) => id !== m.userId
                                        )
                                  )
                                }
                              />
                              <Label
                                className={cn(
                                  "min-w-0 break-all font-normal",
                                  // Disabled only because mail cannot reach them:
                                  // the name still has to be readable.
                                  !m.reachable &&
                                    "text-muted-foreground peer-disabled:opacity-100"
                                )}
                                htmlFor={`wf-recipient-${m.userId}`}
                              >
                                {memberLabel(m)}
                              </Label>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </section>
                  <section className="space-y-2 border-t pt-3">
                    <h3 className="font-semibold text-sm">Methods</h3>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={customChannels !== null}
                          id="wf-own-channels"
                          onCheckedChange={(checked) =>
                            setCustomChannels(
                              checked === true
                                ? view.org.channels.map((c) => ({
                                    key: nextKey(),
                                    kind: c.kind,
                                    integrationId: c.integrationId,
                                    destination: c.destination,
                                    role: c.role,
                                    // A paused org method is copied paused.
                                    pausedReason: c.pausedAt
                                      ? (c.pausedReason ??
                                        "It stopped working.")
                                      : undefined,
                                  }))
                                : null
                            )
                          }
                        />
                        <Label className="text-xs" htmlFor="wf-own-channels">
                          Use different methods
                        </Label>
                      </div>
                      {customChannels !== null && (
                        <ChannelListEditor
                          channels={customChannels}
                          connections={view.connections}
                          onChange={setCustomChannels}
                          onConnectionsChanged={refreshConnections}
                          organizationId={view.organizationId}
                          savedChannels={view.override.channels}
                        />
                      )}
                    </div>
                  </section>
                  {saveErrorBox}
                </div>
              ) : (
                // Not editable here: what it holds, or the org's rules it would start from.
                <RulesView
                  channels={
                    custom ? view.effective.channels : view.org.channels
                  }
                  emails={custom ? view.effective.emails : orgEmails(view)}
                  pauseWorkflow={custom && view.override.pauseWorkflow}
                  threshold={
                    custom ? view.effective.threshold : view.org.threshold
                  }
                  timeLimitMinutes={
                    custom
                      ? view.effective.timeLimitMinutes
                      : view.org.timeLimitMinutes
                  }
                />
              )}
              {!(custom || canManage) && (
                <p className="text-muted-foreground text-xs">
                  Only owners and admins can give this workflow its own rules.
                </p>
              )}
              {!custom && canManage && (
                <p className="text-muted-foreground text-xs">
                  Starts from the org's rules above; once used, change them here
                  and they save themselves.
                </p>
              )}
              <TabFooter inUse={custom}>
                {editing && (
                  <span
                    className={cn(
                      "text-xs",
                      rulesDirty && !rulesReady
                        ? WARNING_TEXT
                        : "text-muted-foreground",
                      saveFailed && "text-destructive"
                    )}
                    data-testid="failure-alerts-autosave"
                    role="status"
                  >
                    {autosaveLine}
                  </span>
                )}
                {editing && canRetry && !saving && (
                  <Button
                    className="h-auto px-0 text-xs"
                    data-testid="failure-alerts-autosave-retry"
                    onClick={() => {
                      saveDraft().catch(() => undefined);
                    }}
                    type="button"
                    variant="link"
                  >
                    Try again
                  </Button>
                )}
                {!custom && canManage && (
                  <Button
                    className={WRAP_BUTTON}
                    data-testid="failure-alerts-use-custom"
                    disabled={saving}
                    onClick={() => {
                      switchToCustom().catch(() => undefined);
                    }}
                    size="sm"
                    type="button"
                  >
                    Use custom rules
                  </Button>
                )}
              </TabFooter>
            </TabsContent>
          </Tabs>

          <p className="text-muted-foreground text-xs">{FUNDS_RULE}</p>
          {view.org.unreachable && !custom && (
            <Notice tone="danger">
              Nobody can be reached right now. Fix it in{" "}
              <Link
                className="underline underline-offset-4"
                href={`/settings/${view.organizationId}/alerts`}
              >
                Alerts
              </Link>
              .
            </Notice>
          )}
          {!canManage && (
            <p className="text-muted-foreground text-xs">
              Only owners and admins can change alert settings.
            </p>
          )}

          {!editing && saveErrorBox}
          {canManage && panel === null && (
            <div className="flex flex-wrap gap-2 border-t pt-3">
              {muted ? (
                <Button
                  className={WRAP_BUTTON}
                  data-testid="failure-alerts-unmute"
                  disabled={saving}
                  onClick={unmute}
                  ref={muteButtonRef}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Unmute
                </Button>
              ) : (
                <Button
                  className={WRAP_BUTTON}
                  data-testid="failure-alerts-mute-open"
                  onClick={() => openPanel("mute")}
                  ref={muteButtonRef}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <BellOff className="size-3.5" />
                  Mute
                </Button>
              )}
            </div>
          )}

          {panel === "mute" && (
            <div
              className="space-y-2"
              data-testid="failure-alerts-mute"
              ref={panelRef}
            >
              <p className="text-xs">Mute alerts for</p>
              <div className="flex flex-wrap gap-2">
                {MUTE_CHOICES.map((choice) => (
                  <Button
                    data-mute={choice.id}
                    disabled={saving}
                    key={choice.id}
                    onClick={() => mute(choice.ms)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {choice.label}
                  </Button>
                ))}
              </div>
              <Label className="text-xs" htmlFor="wf-mute-until">
                Or until
              </Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="h-8 w-auto"
                  id="wf-mute-until"
                  max={toLocalInput(
                    new Date(Date.now() + MAX_MUTE_DAYS * 24 * HOUR_MS)
                  )}
                  min={toLocalInput(new Date())}
                  onChange={(e) => setMuteDate(e.target.value)}
                  type="datetime-local"
                  value={muteDate}
                />
                <Button
                  disabled={saving || !muteDate}
                  onClick={() => mute("date")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Mute until then
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                Up to {MAX_MUTE_DAYS} days. Alerts start again by themselves if
                it is still failing.
              </p>
              <Button
                onClick={() => {
                  setSaveError(null);
                  setPanel(null);
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="ml-1 flex flex-wrap gap-x-4 text-xs">
        <Link
          className={FOOTER_LINK}
          href={`/settings/${view.organizationId}/alerts?tab=setup`}
        >
          Org alert rules
        </Link>
        <Button
          aria-expanded={showHistory}
          className={cn(FOOTER_LINK, "h-auto px-0 font-normal text-xs")}
          onClick={() => setShowHistory((open) => !open)}
          type="button"
          variant="link"
        >
          {showHistory
            ? "Hide recent alerts"
            : "Recent alerts for this workflow"}
        </Button>
      </div>
      {showHistory && (
        <NotificationHistory
          compact
          organizationId={view.organizationId}
          workflowId={workflowId}
        />
      )}
    </div>
  );
}
