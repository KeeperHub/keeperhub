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
import { Notice } from "@/components/ui/notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MAX_MUTE_DAYS,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  TIME_LIMIT_OPTIONS_MINUTES,
} from "@/lib/notifications/failure-alerts/constants";
import {
  channelLabel,
  type WorkflowAlertView,
} from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";
import {
  isWorkflowEnabled,
  propertiesPanelActiveTabAtom,
  workflowEnableToggleAtom,
} from "@/lib/workflow/store";
import { fetchView } from "./api";
import {
  ChannelListEditor,
  channelsPayload,
  type DraftChannel,
  draftsFromViews,
} from "./channel-list-editor";
import { memberLabel } from "./member-label";
import { NotificationHistory } from "./notification-history";

type Loaded = WorkflowAlertView & { canManage: boolean };
type Panel = null | "mute" | "custom";

const TIME_LABEL: Record<number, string> = {
  60: "1 hour",
  360: "6 hours",
  1440: "24 hours",
};

const HOUR_MS = 60 * 60 * 1000;

/** The first thing to focus when a panel opens. */
const FOCUSABLE = "button:not([disabled]), input:not([disabled])";

/** Footer links stay at least 44px tall below sm, for a thumb. */
const FOOTER_LINK =
  "inline-flex min-h-11 items-center underline underline-offset-4 hover:text-foreground sm:min-h-0";
const MUTE_CHOICES: { label: string; ms: number | "success" }[] = [
  { label: "1 hour", ms: HOUR_MS },
  { label: "24 hours", ms: 24 * HOUR_MS },
  { label: "7 days", ms: 7 * 24 * HOUR_MS },
  { label: "Until it works again", ms: "success" },
];

function describeTimeLimit(minutes: number | null): string {
  return minutes
    ? ` or ${TIME_LABEL[minutes] ?? `${minutes} minutes`} of failing`
    : "";
}

function summary(view: Loaded): string {
  const who =
    view.effective.emails.length > 0
      ? `Emails ${view.effective.emails.join(", ")}`
      : "Nobody can be emailed";
  const channels = view.effective.channels
    .filter((c) => !c.pausedAt)
    .map(
      (c) =>
        `${channelLabel(c.kind, c.destination, c.connectionName)}${c.role === "backup" ? " (backup)" : ""}`
    );
  const also = channels.length > 0 ? `, plus ${channels.join(", ")}` : "";
  return `${who}${also}, after ${view.effective.threshold} failed run${view.effective.threshold === 1 ? "" : "s"} in a row${describeTimeLimit(view.effective.timeLimitMinutes)}.`;
}

function isMutedView(view: Loaded): boolean {
  return Boolean(view.override.mutedUntil || view.override.muteUntilSuccess);
}

function toLocalInput(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * "Notifications on fail" in a workflow's Properties: what applies, whether
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

  if (!view) {
    return (
      <div className="space-y-2">
        <Label className="ml-1">Notifications on fail</Label>
        {loadFailed ? (
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
  });

  const put = async (
    body: Record<string, unknown>,
    done: string
  ): Promise<boolean> => {
    setSaving(true);
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Loaded & {
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? "Could not save");
        return false;
      }
      apply(data);
      toast.success(done);
      return true;
    } catch {
      toast.error("Could not save");
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
      "This workflow follows the org setting again"
    );
    if (ok) {
      setPanel(null);
    }
  };

  let tag: { label: string; className?: string } = { label: "Org setting" };
  if (!applies) {
    tag = { label: "Does not apply" };
  } else if (muted) {
    tag = {
      label: "Muted",
      className: "border-yellow-500/40 text-yellow-600 dark:text-yellow-400",
    };
  } else if (custom) {
    tag = { label: "Custom" };
  }

  return (
    <div className="space-y-3" data-testid="workflow-failure-alerts">
      <div className="ml-1 flex items-center gap-2">
        <Label>Notifications on fail</Label>
        <Badge className={tag.className} variant="outline">
          {tag.label}
        </Badge>
      </div>

      {!applies && (
        <p className="rounded-lg border border-dashed p-3 text-muted-foreground text-sm">
          Only runs started by hand, so failure alerts don't apply: you see the
          result yourself. Use a Schedule, Event, Block, Webhook, Transfer or
          Pyth Price trigger to get them.
        </p>
      )}

      {applies && view.status.incident && (
        <Notice className="p-3 text-sm" tone="danger">
          <div className="space-y-2">
            <p className="font-medium">
              Failing, {view.status.incident.failureCount} runs in a row
            </p>
            <p className="text-xs">
              {view.status.incident.deliveredTo.length > 0
                ? `Alert sent ${timeAgo(view.status.incident.openedAt)} to ${view.status.incident.deliveredTo.join(", ")}, after ${view.status.incident.threshold} failed runs in a row.`
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
            </div>
          </div>
        </Notice>
      )}

      {applies && !view.status.incident && view.status.failures > 0 && (
        <Notice className="p-3" tone="warning">
          <p className="font-medium text-sm">
            Failing: {view.status.failures} failed run
            {view.status.failures === 1 ? "" : "s"} in a row
          </p>
          <p className="text-foreground">
            {view.status.firstFailedAt
              ? `Started failing ${timeAgo(view.status.firstFailedAt)}. `
              : null}
            The alert goes out at {view.effective.threshold} failed runs
            {describeTimeLimit(view.effective.timeLimitMinutes)}.
          </p>
        </Notice>
      )}

      {applies && (
        <div className="space-y-3 rounded-lg border bg-muted/20 p-3 text-sm">
          {muted ? (
            <p className="flex items-start gap-2">
              <BellOff
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-yellow-600 dark:text-yellow-400"
              />
              <span>
                {view.override.muteUntilSuccess
                  ? "Muted until it works again"
                  : `Muted until ${formatWhen(view.override.mutedUntil ?? "")}`}
                {view.override.mutedBy ? ` by ${view.override.mutedBy}` : ""}.
                Failures still show in Runs.
              </span>
            </p>
          ) : (
            <p>{summary(view)}</p>
          )}
          {view.org.unreachable && !custom && (
            <Notice tone="danger">
              Nobody can be reached right now. Add an email or a channel in{" "}
              <Link
                className="underline underline-offset-4"
                href={`/settings/${view.organizationId}/notifications`}
              >
                Notification settings
              </Link>
              .
            </Notice>
          )}
          {!canManage && (
            <p className="text-muted-foreground text-xs">
              Only owners and admins can change these settings.
            </p>
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
                {custom ? "Edit for this workflow" : "Customize"}
              </Button>
              {custom && (
                <Button
                  disabled={saving}
                  onClick={followOrgSetting}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Use org setting
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
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="Mute until a date and time"
                  className="h-8 w-auto"
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
                Anything left on "Org setting" keeps following the org.
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
                  placeholder={`Org setting: ${view.org.threshold}`}
                  type="number"
                  value={threshold}
                />
                {thresholdInvalid && (
                  <p
                    className="text-destructive text-xs"
                    id="wf-failure-threshold-error"
                  >
                    Use a whole number from {MIN_THRESHOLD} to {MAX_THRESHOLD},
                    or leave it empty to follow the org.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Or after failing for</Label>
                <Select onValueChange={setTimeLimit} value={timeLimit}>
                  <SelectTrigger
                    aria-label="Time limit"
                    className="h-8 w-full"
                    size="sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="org">
                      Org setting (
                      {view.org.timeLimitMinutes
                        ? TIME_LABEL[view.org.timeLimitMinutes]
                        : "off"}
                      )
                    </SelectItem>
                    <SelectItem value="off">Off</SelectItem>
                    {TIME_LIMIT_OPTIONS_MINUTES.map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {TIME_LABEL[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                    Org setting:{" "}
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
                          ? draftsFromViews(view.org.channels).map((c) => ({
                              ...c,
                              id: undefined,
                              key: `copy-${c.key}`,
                            }))
                          : null
                      )
                    }
                  />
                  <Label className="text-xs" htmlFor="wf-own-channels">
                    Use different channels
                  </Label>
                </div>
                {customChannels !== null && (
                  <ChannelListEditor
                    canManage
                    channels={customChannels}
                    connections={view.connections}
                    onChange={setCustomChannels}
                    onConnectionsChanged={refreshConnections}
                    organizationId={view.organizationId}
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

      <div className="ml-1 flex flex-wrap gap-x-4 text-muted-foreground text-xs">
        <Link
          className={FOOTER_LINK}
          href={`/settings/${view.organizationId}/notifications`}
        >
          Notification settings
        </Link>
        <button
          aria-expanded={showHistory}
          className={FOOTER_LINK}
          onClick={() => setShowHistory((open) => !open)}
          type="button"
        >
          {showHistory ? "Hide alert history" : "Alert history"}
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
