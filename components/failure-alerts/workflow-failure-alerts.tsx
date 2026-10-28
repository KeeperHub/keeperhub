"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { BellOff, Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { timeAgo } from "@/components/settings/hub/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice, WARNING_TEXT } from "@/components/ui/notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAlertsEnabled } from "@/lib/hooks/use-notifications";
import { useOrganization } from "@/lib/hooks/use-organization";
import {
  MAX_MUTE_DAYS,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  TIME_LIMIT_OPTIONS_MINUTES,
} from "@/lib/notifications/failure-alerts/constants";
import type { WorkflowAlertView } from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";
import {
  isWorkflowEnabled,
  propertiesPanelActiveTabAtom,
  workflowEnableToggleAtom,
} from "@/lib/workflow/store";
import { fetchView } from "./api";
import { ChannelListEditor } from "./channel-list-editor";
import {
  describeRule,
  failedRuns,
  formatWhen,
  timeLimitLabel,
  toLocalInput,
} from "./format";
import { memberLabel } from "./member-label";
import {
  channelsPayload,
  type DraftChannel,
  draftsFromViews,
  nextKey,
} from "./method-drafts";
import { NotificationHistory } from "./notification-history";

type Loaded = WorkflowAlertView & { canManage: boolean };
type Panel = null | "mute" | "custom";

const HOUR_MS = 60 * 60 * 1000;
// One id for every save toast, so "muted" then "back on" replace each other
// instead of stacking over the panel's buttons.
const SAVE_TOAST = "workflow-failure-alerts-save";

/** The first thing to focus when a panel opens. */
const FOCUSABLE = "button:not([disabled]), input:not([disabled])";

/** Footer links stay at least 44px tall below sm, for a thumb. */
const FOOTER_LINK =
  "inline-flex min-h-11 items-center text-foreground underline underline-offset-4 sm:min-h-0";
const STALE_TOAST =
  "These settings were changed by someone else. Reload to see the latest, then save again.";
const MUTE_CHOICES: { label: string; ms: number | "success" }[] = [
  { label: "1 hour", ms: HOUR_MS },
  { label: "24 hours", ms: 24 * HOUR_MS },
  { label: "7 days", ms: 7 * 24 * HOUR_MS },
  { label: "Until it works again", ms: "success" },
];

function describeTimeLimit(minutes: number | null): string {
  return minutes ? ` or ${timeLimitLabel(minutes)} of failing` : "";
}

function summary(view: Loaded): string {
  return describeRule({
    threshold: view.effective.threshold,
    timeLimitMinutes: view.effective.timeLimitMinutes,
    emails: view.effective.emails,
    channels: view.effective.channels,
    pauseWorkflow: view.override.pauseWorkflow,
    scope: "workflow",
  });
}

function incidentTitle(
  incident: NonNullable<Loaded["status"]["incident"]>,
  pausedByAlert: boolean
): string {
  if (incident.openedBy === "missed") {
    return `Did not run at ${formatWhen(incident.since)}`;
  }
  const runs = `${failedRuns(incident.failureCount)} in a row`;
  if (incident.openedBy === "funding" && !pausedByAlert) {
    return `Wallet out of funds: ${runs}`;
  }
  return pausedByAlert ? `Paused after ${runs}` : `Failing: ${runs}`;
}

/** "1 more failed run" before the alert, for a workflow that turns itself off. */
function runsLeft(view: Loaded): string {
  const left = Math.max(view.effective.threshold - view.status.failures, 1);
  return `${left} more failed run${left === 1 ? "" : "s"}`;
}

function isMutedView(view: Loaded): boolean {
  return Boolean(view.override.mutedUntil || view.override.muteUntilSuccess);
}

/**
 * "Alerts" in a workflow's Properties: what applies, whether
 * it is failing right now, a one-click mute, and a way to customise it.
 */
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
  const [staleError, setStaleError] = useState<string | null>(null);
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
  const panelRef = useRef<HTMLDivElement>(null);
  const muteButtonRef = useRef<HTMLButtonElement>(null);
  const customButtonRef = useRef<HTMLButtonElement>(null);
  // Which button opened the panel, to give focus back to when it closes.
  const openerRef = useRef<Panel>(null);

  const url = `/api/workflows/${encodeURIComponent(workflowId)}/failure-alerts`;

  const apply = useCallback((next: Loaded) => {
    setView(next);
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
  }, []);

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
    let active = true;
    load(() => active).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [load]);

  useEffect(() => {
    if (panel) {
      panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
      return;
    }
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener === "mute") {
      muteButtonRef.current?.focus();
    } else if (opener === "custom") {
      customButtonRef.current?.focus();
    }
  }, [panel]);

  // Escape closes a panel like Cancel. A native listener on the panel's own
  // DOM, so the Escape of a select opened from it (rendered in a portal)
  // closes only that list.
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
      if (panel === "custom") {
        apply(view);
      }
      setPanel(null);
    };
    element.addEventListener("keydown", onKeyDown);
    return () => element.removeEventListener("keydown", onKeyDown);
  }, [panel, view, apply]);

  const openPanel = (next: Exclude<Panel, null>): void => {
    openerRef.current = next;
    setPanel(next);
  };

  const refreshConnections = useCallback(async () => {
    const res = await fetch(url);
    if (res.ok) {
      const body = (await res.json()) as Loaded;
      setView((prev) =>
        prev ? { ...prev, connections: body.connections } : prev
      );
    }
  }, [url]);

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
                Retry
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
  // Off because its alert paused it, and not turned back on since.
  const pausedAt = view.status.incident?.workflowPausedAt ?? null;
  const resumedAt = view.status.incident?.workflowResumedAt ?? null;
  const pausedByAlert =
    pausedAt !== null &&
    (resumedAt === null || resumedAt < pausedAt) &&
    !enabled;
  const thresholdInvalid =
    threshold.trim() !== "" &&
    !(
      Number.isInteger(Number(threshold)) &&
      Number(threshold) >= MIN_THRESHOLD &&
      Number(threshold) <= MAX_THRESHOLD
    );

  /** The override as stored, so a mute change keeps the custom fields. */
  const storedOverride = (): Record<string, unknown> => ({
    threshold: view.override.threshold,
    timeLimitMinutes: view.override.timeLimitMinutes,
    recipientUserIds: view.override.recipientUserIds,
    customChannels: view.override.customChannels,
    channels: channelsPayload(draftsFromViews(view.override.channels)),
    pauseWorkflow: view.override.pauseWorkflow,
  });
  const orgPause =
    view.org.pause && new Date(view.org.pause.until).getTime() > Date.now()
      ? view.org.pause
      : null;

  const put = async (
    body: Record<string, unknown>,
    done: string
  ): Promise<boolean> => {
    setSaving(true);
    setStaleError(null);
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, version: view.version }),
      });
      const data = (await res.json().catch(() => ({}))) as Loaded & {
        error?: string;
      };
      if (res.status === 409) {
        setStaleError(data.error ?? STALE_TOAST);
        return false;
      }
      if (!res.ok) {
        toast.error(data.error ?? "Could not save. Try again.", {
          id: SAVE_TOAST,
        });
        return false;
      }
      apply(data);
      toast.success(done, { id: SAVE_TOAST });
      return true;
    } catch {
      toast.error("Could not save. Try again.", { id: SAVE_TOAST });
      return false;
    } finally {
      setSaving(false);
    }
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
    const ok = await put(
      {
        ...storedOverride(),
        mutedUntil,
        muteUntilSuccess: choice === "success",
      },
      "Alerts muted for this workflow"
    );
    if (ok) {
      setPanel(null);
    }
  };

  const unmute = async (): Promise<void> => {
    await put(storedOverride(), "Alerts back on for this workflow");
  };

  const saveCustom = async (): Promise<void> => {
    if (thresholdInvalid) {
      document.getElementById("wf-failure-threshold")?.focus();
      return;
    }
    const parsedThreshold = threshold.trim() ? Number(threshold) : null;
    let timeLimitMinutes: number | null = null;
    if (timeLimit === "off") {
      timeLimitMinutes = 0;
    } else if (timeLimit !== "org") {
      timeLimitMinutes = Number(timeLimit);
    }
    const ok = await put(
      {
        threshold: parsedThreshold,
        timeLimitMinutes,
        recipientUserIds: customRecipients,
        customChannels: customChannels !== null,
        channels: customChannels ? channelsPayload(customChannels) : [],
        mutedUntil: view.override.mutedUntil,
        muteUntilSuccess: view.override.muteUntilSuccess,
        pauseWorkflow,
      },
      "Saved for this workflow"
    );
    if (ok) {
      setPanel(null);
    }
  };

  const followOrgSetting = async (): Promise<void> => {
    const ok = await put(
      {
        mutedUntil: view.override.mutedUntil,
        muteUntilSuccess: view.override.muteUntilSuccess,
      },
      "Back on the org rules"
    );
    if (ok) {
      setPanel(null);
    }
  };

  let tag: { label: string; className?: string } = { label: "Org rules" };
  if (!applies) {
    tag = { label: "Not used" };
  } else if (muted) {
    tag = {
      label: "Muted",
      className: WARNING_TEXT,
    };
  } else if (custom) {
    tag = { label: "Own settings" };
  }

  return (
    <div
      className="scroll-mt-20 space-y-3"
      data-testid="workflow-failure-alerts"
    >
      <div className="ml-1 flex items-center gap-2">
        <Label>Alerts</Label>
        <Badge className={tag.className} variant="outline">
          {tag.label}
        </Badge>
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
          <div className="space-y-2">
            <p className="font-medium">
              {incidentTitle(view.status.incident, pausedByAlert)}
            </p>
            {pausedByAlert && (
              <p className="text-xs">
                KeeperHub turned it off, as set for this workflow. Fix the
                cause, then turn it back on with the Enable switch.
              </p>
            )}
            <p className="text-xs">
              {view.status.incident.deliveredTo.length > 0
                ? `Alert sent ${timeAgo(view.status.incident.openedAt)} to ${view.status.incident.deliveredTo.join(", ")}.`
                : `Alert queued ${timeAgo(view.status.incident.openedAt)}, not delivered yet.`}
            </p>
            {view.status.lastError && (
              <p className="break-words font-mono text-xs">
                {view.status.lastError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => setActiveTab("runs")}
                size="sm"
                type="button"
                variant="outline"
              >
                View failed runs
              </Button>
              {enableToggle && enabled && (
                <Button
                  onClick={() => enableToggle.toggle(false)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Pause workflow
                </Button>
              )}
              {enableToggle && pausedByAlert && (
                <Button
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
        <div className="space-y-3 rounded-lg border bg-muted/20 p-3 text-sm">
          {muted ? (
            <p className="flex items-start gap-2">
              <BellOff
                aria-hidden="true"
                className={cn("mt-0.5 size-4 shrink-0", WARNING_TEXT)}
              />
              <span>
                {view.override.muteUntilSuccess
                  ? "Muted until it works again"
                  : `Muted until ${formatWhen(view.override.mutedUntil ?? "")}`}
                {view.override.mutedBy ? ` by ${view.override.mutedBy}` : ""}.
                Failures still show in Runs; nobody is told.
                {view.override.pauseWorkflow &&
                  " It is still paused at the limit, and people are told."}
              </span>
            </p>
          ) : (
            <p role="status">{summary(view)}</p>
          )}
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

          {staleError && (
            <div data-stale="true" data-testid="failure-alert-save-error">
              <Notice role="alert" tone="danger">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>
                    <span className="font-medium">Not saved.</span> {staleError}
                  </span>
                  <Button
                    className="h-auto px-0 text-xs"
                    onClick={() => {
                      setStaleError(null);
                      setPanel(null);
                      load().catch(() => undefined);
                    }}
                    type="button"
                    variant="link"
                  >
                    Reload
                  </Button>
                </span>
              </Notice>
            </div>
          )}
          {canManage && panel === null && (
            <div className="flex flex-wrap gap-2">
              {muted ? (
                <Button
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
                  onClick={() => openPanel("mute")}
                  ref={muteButtonRef}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Mute
                </Button>
              )}
              <Button
                onClick={() => openPanel("custom")}
                ref={customButtonRef}
                size="sm"
                type="button"
                variant="outline"
              >
                {custom ? "Edit" : "Change for this workflow"}
              </Button>
              {custom && (
                <Button
                  className="h-auto min-h-11 px-0 text-xs sm:min-h-0"
                  disabled={saving}
                  onClick={followOrgSetting}
                  type="button"
                  variant="link"
                >
                  Reset to org rules
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
                    disabled={saving}
                    key={choice.label}
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
                onClick={() => setPanel(null)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
            </div>
          )}

          {panel === "custom" && (
            <div
              className="space-y-4"
              data-testid="failure-alerts-custom"
              ref={panelRef}
            >
              <p className="text-muted-foreground text-xs">
                Empty fields follow the org rules.
              </p>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="wf-failure-threshold">
                  Failed runs in a row
                </Label>
                <Input
                  aria-describedby={
                    thresholdInvalid ? "wf-failure-threshold-error" : undefined
                  }
                  aria-invalid={thresholdInvalid}
                  className="h-8"
                  id="wf-failure-threshold"
                  inputMode="numeric"
                  max={MAX_THRESHOLD}
                  min={MIN_THRESHOLD}
                  onChange={(e) => setThreshold(e.target.value)}
                  placeholder={`Org: ${view.org.threshold}`}
                  type="number"
                  value={threshold}
                />
                {thresholdInvalid && (
                  <p
                    className="text-destructive text-xs"
                    id="wf-failure-threshold-error"
                  >
                    Use a whole number from {MIN_THRESHOLD} to {MAX_THRESHOLD},
                    or leave it empty for the org rules.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="wf-time-limit">
                  Or after failing for
                </Label>
                <Select onValueChange={setTimeLimit} value={timeLimit}>
                  <SelectTrigger
                    className="h-8 w-full"
                    id="wf-time-limit"
                    size="sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="org">
                      Org:{" "}
                      {view.org.timeLimitMinutes
                        ? timeLimitLabel(view.org.timeLimitMinutes)
                        : "off"}
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
                    Pause this workflow when it reaches the limit
                  </Label>
                </div>
                <p
                  className="pl-6 text-muted-foreground text-xs"
                  id="wf-pause-workflow-help"
                >
                  Turns it off when its alert goes out. Any failure counts. Turn
                  it back on with the Enable switch.
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={customRecipients !== null}
                    id="wf-own-recipients"
                    onCheckedChange={(checked) =>
                      setCustomRecipients(
                        checked === true ? [...view.org.recipientUserIds] : null
                      )
                    }
                  />
                  <Label className="text-xs" htmlFor="wf-own-recipients">
                    Email different people
                  </Label>
                </div>
                {customRecipients === null ? (
                  <p className="text-muted-foreground text-xs">
                    Org:{" "}
                    {view.effective.emails.join(", ") || "nobody reachable"}
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
                                ? [...new Set([...customRecipients, m.userId])]
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
                                ? (c.pausedReason ?? "It stopped working.")
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
              <div className="flex justify-end gap-2">
                <Button
                  onClick={() => {
                    apply(view);
                    setPanel(null);
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button
                  disabled={saving}
                  onClick={saveCustom}
                  size="sm"
                  type="button"
                >
                  {saving ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="ml-1 flex flex-wrap gap-x-4 text-xs">
        <Link
          className={FOOTER_LINK}
          href={`/settings/${view.organizationId}/alerts`}
        >
          Org alert rules
        </Link>
        <button
          aria-expanded={showHistory}
          className={FOOTER_LINK}
          onClick={() => setShowHistory((open) => !open)}
          type="button"
        >
          {showHistory ? "Hide sent alerts" : "Sent alerts for this workflow"}
        </button>
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
