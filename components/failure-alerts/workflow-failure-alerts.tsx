"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { AlertTriangle, BellOff, Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import type { WorkflowAlertView } from "@/lib/notifications/failure-alerts/view-types";
import { getRelativeTime } from "@/lib/utils/time";
import {
  isWorkflowEnabled,
  propertiesPanelActiveTabAtom,
  workflowEnableToggleAtom,
} from "@/lib/workflow/store";
import { CHANNEL_LABEL } from "./api";
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
        `${CHANNEL_LABEL[c.kind]}${c.kind === "discord" ? "" : ` ${c.destination}`}${c.role === "backup" ? " (backup)" : ""}`
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
  const [panel, setPanel] = useState<Panel>(null);
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const enableToggle = useAtomValue(workflowEnableToggleAtom);
  const enabled = useAtomValue(isWorkflowEnabled);

  // Customise form
  const [threshold, setThreshold] = useState("");
  const [timeLimit, setTimeLimit] = useState("org");
  const [customRecipients, setCustomRecipients] = useState<string[] | null>(
    null
  );
  const [customChannels, setCustomChannels] = useState<DraftChannel[] | null>(
    null
  );
  const [muteDate, setMuteDate] = useState("");

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

  useEffect(() => {
    fetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: Loaded | null) => {
        if (body) {
          apply(body);
        }
      })
      .catch(() => undefined);
  }, [apply, url]);

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
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <Loader2 className="size-3.5 animate-spin" />
          Loading
        </div>
      </div>
    );
  }

  const applies = Boolean(triggerType && triggerType !== "Manual");
  const canManage = view.canManage;
  const muted = isMutedView(view);
  const custom = view.effective.source === "custom";

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
    let parsedThreshold: number | null = null;
    if (threshold.trim()) {
      parsedThreshold = Number(threshold);
      if (
        !Number.isInteger(parsedThreshold) ||
        parsedThreshold < MIN_THRESHOLD ||
        parsedThreshold > MAX_THRESHOLD
      ) {
        toast.error(
          `Failed runs in a row must be a whole number from ${MIN_THRESHOLD} to ${MAX_THRESHOLD}.`
        );
        return;
      }
    }
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
          result yourself. Use a Schedule, Event, Block or Webhook trigger to
          get them.
        </p>
      )}

      {applies && view.status.incident && (
        <div className="space-y-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle
              aria-hidden="true"
              className="size-4 text-destructive"
            />
            Failing, {view.status.incident.failureCount} runs in a row
          </p>
          <p className="text-xs">
            Alert sent {getRelativeTime(view.status.incident.openedAt)}
            {view.status.incident.deliveredTo.length > 0
              ? ` to ${view.status.incident.deliveredTo.join(", ")}`
              : ", not delivered yet"}
            .
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
      )}

      {applies && !view.status.incident && view.status.failures > 0 && (
        <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm">
          <p className="font-medium text-yellow-700 dark:text-yellow-300">
            Failing: {view.status.failures} failed run
            {view.status.failures === 1 ? "" : "s"} in a row
          </p>
          <p className="text-xs">
            {view.status.firstFailedAt
              ? `Since ${getRelativeTime(view.status.firstFailedAt)}. `
              : null}
            The alert goes out at {view.effective.threshold} failed runs
            {describeTimeLimit(view.effective.timeLimitMinutes)}.
          </p>
        </div>
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
            <p className="text-destructive text-xs">
              Nobody can be reached right now. Add an email or a channel in
              notification settings.
            </p>
          )}

          {canManage && panel === null && (
            <div className="flex flex-wrap gap-2">
              {muted ? (
                <Button
                  disabled={saving}
                  onClick={unmute}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Unmute
                </Button>
              ) : (
                <Button
                  onClick={() => setPanel("mute")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Mute
                </Button>
              )}
              <Button
                onClick={() => setPanel("custom")}
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
            <div className="space-y-2" data-testid="failure-alerts-mute">
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
            <div className="space-y-4" data-testid="failure-alerts-custom">
              <p className="text-muted-foreground text-xs">
                Anything left on "Org setting" keeps following the org.
              </p>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="wf-failure-threshold">
                  Failed runs in a row
                </Label>
                <Input
                  className="h-8"
                  id="wf-failure-threshold"
                  inputMode="numeric"
                  onChange={(e) => setThreshold(e.target.value)}
                  placeholder={`Org setting: ${view.org.threshold}`}
                  type="number"
                  value={threshold}
                />
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
                          className="min-w-0 break-all font-normal"
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

      <div className="ml-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <Link
          className="underline-offset-4 hover:underline"
          href={`/settings/${view.organizationId}/notifications`}
        >
          Org setting
        </Link>
        <button
          className="underline-offset-4 hover:underline"
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
