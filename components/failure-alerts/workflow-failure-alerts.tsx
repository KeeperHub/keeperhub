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
import { cn } from "@/lib/utils";
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
type Mode = "default" | "custom" | "muted";

const TIME_LABEL: Record<number, string> = {
  60: "1 hour",
  360: "6 hours",
  1440: "24 hours",
};

function describeTimeLimit(minutes: number | null): string {
  return minutes
    ? ` or ${TIME_LABEL[minutes] ?? `${minutes} minutes`} of failing`
    : "";
}

function summary(view: Loaded): string {
  const who =
    view.effective.emails.length > 0
      ? `Email ${view.effective.emails.join(", ")}`
      : "Nobody can be emailed";
  const channels = view.effective.channels
    .filter((c) => !c.pausedAt)
    .map(
      (c) =>
        `${CHANNEL_LABEL[c.kind]}${c.kind === "discord" ? "" : ` ${c.destination}`}${c.role === "backup" ? " (backup)" : ""}`
    );
  const also = channels.length > 0 ? `. Also ${channels.join(", ")}` : "";
  return `${who} after ${view.effective.threshold} failed run${view.effective.threshold === 1 ? "" : "s"} in a row${describeTimeLimit(view.effective.timeLimitMinutes)}${also}.`;
}

function modeOf(view: Loaded): Mode {
  if (view.override.mutedUntil || view.override.muteUntilSuccess) {
    return "muted";
  }
  return view.effective.source === "custom" ? "custom" : "default";
}

type MuteChoice = "24h" | "7d" | "success" | "date";

function toLocalInput(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * "Notifications on fail" in a workflow's Properties: what applies to this
 * workflow, its failing state right now, and a way to customise or mute it.
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
  const [mode, setMode] = useState<Mode>("default");
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const enableToggle = useAtomValue(workflowEnableToggleAtom);
  const enabled = useAtomValue(isWorkflowEnabled);

  // Custom form
  const [threshold, setThreshold] = useState("");
  const [timeLimit, setTimeLimit] = useState("org");
  const [customRecipients, setCustomRecipients] = useState<string[] | null>(
    null
  );
  const [customChannels, setCustomChannels] = useState<DraftChannel[] | null>(
    null
  );
  // Mute form
  const [muteChoice, setMuteChoice] = useState<MuteChoice>("24h");
  const [muteDate, setMuteDate] = useState("");
  const [muteReason, setMuteReason] = useState("");

  const url = `/api/workflows/${encodeURIComponent(workflowId)}/failure-alerts`;

  const apply = useCallback((next: Loaded) => {
    setView(next);
    setMode(modeOf(next));
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
    setMuteReason(next.override.muteReason ?? "");
  }, []);

  const load = useCallback(async () => {
    const res = await fetch(url);
    if (res.ok) {
      apply((await res.json()) as Loaded);
    }
  }, [apply, url]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

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
  const settingsHref = `/settings/${view.organizationId}/notifications`;

  const put = async (
    body: Record<string, unknown>,
    done: string
  ): Promise<void> => {
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
        return;
      }
      apply(data);
      toast.success(done);
    } catch {
      toast.error("Could not save");
    } finally {
      setSaving(false);
    }
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
    await put(
      {
        threshold: parsedThreshold,
        timeLimitMinutes,
        recipientUserIds: customRecipients,
        customChannels: customChannels !== null,
        channels: customChannels ? channelsPayload(customChannels) : [],
      },
      "Saved for this workflow"
    );
  };

  const saveMute = async (): Promise<void> => {
    const now = Date.now();
    let mutedUntil: string | null = null;
    if (muteChoice === "24h") {
      mutedUntil = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    } else if (muteChoice === "7d") {
      mutedUntil = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
    } else if (muteChoice === "date") {
      if (!muteDate) {
        toast.error("Pick when the mute ends.");
        return;
      }
      mutedUntil = new Date(muteDate).toISOString();
    }
    await put(
      {
        threshold: view.override.threshold,
        timeLimitMinutes: view.override.timeLimitMinutes,
        recipientUserIds: view.override.recipientUserIds,
        customChannels: view.override.customChannels,
        channels: channelsPayload(draftsFromViews(view.override.channels)),
        mutedUntil,
        muteUntilSuccess: muteChoice === "success",
        muteReason,
      },
      "Alerts muted for this workflow"
    );
  };

  const unmute = async (): Promise<void> => {
    await put(
      {
        threshold: view.override.threshold,
        timeLimitMinutes: view.override.timeLimitMinutes,
        recipientUserIds: view.override.recipientUserIds,
        customChannels: view.override.customChannels,
        channels: channelsPayload(draftsFromViews(view.override.channels)),
      },
      "Alerts back on for this workflow"
    );
  };

  const resetAll = async (): Promise<void> => {
    await put({}, "This workflow follows the org default again");
  };

  let tag: { label: string; className?: string } = { label: "Org default" };
  if (!applies) {
    tag = { label: "Does not apply" };
  } else if (modeOf(view) === "muted") {
    tag = {
      label: "Muted",
      className: "border-yellow-500/40 text-yellow-600 dark:text-yellow-400",
    };
  } else if (view.effective.source === "custom") {
    tag = { label: "Custom" };
  }

  const maxDate = toLocalInput(
    new Date(Date.now() + MAX_MUTE_DAYS * 24 * 60 * 60 * 1000)
  );

  return (
    <div className="space-y-3" data-testid="workflow-failure-alerts">
      <div className="ml-1 flex items-center gap-2">
        <Label>Notifications on fail</Label>
        <Badge className={tag.className} variant="outline">
          {tag.label}
        </Badge>
      </div>

      {!applies && (
        <div className="rounded-lg border border-dashed p-3 text-muted-foreground text-sm">
          This workflow only runs when someone starts it, and they see the
          result right away, so failure alerts don't apply. Switch the trigger
          to Schedule, Event, Block or Webhook to get them.
        </div>
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
            {canManage && modeOf(view) !== "muted" && (
              <Button
                onClick={() => setMode("muted")}
                size="sm"
                type="button"
                variant="outline"
              >
                Mute
              </Button>
            )}
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
            An alert goes out at {view.effective.threshold} failed runs
            {describeTimeLimit(view.effective.timeLimitMinutes)}.
          </p>
        </div>
      )}

      {applies && (
        <>
          {canManage && (
            <fieldset className="grid grid-cols-3 gap-1 rounded-lg border p-1">
              <legend className="sr-only">Alert mode</legend>
              {(
                [
                  ["default", "Org default"],
                  ["custom", "Custom"],
                  ["muted", "Muted"],
                ] as const
              ).map(([value, label]) => (
                <button
                  aria-pressed={mode === value}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-xs transition-colors",
                    mode === value
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  key={value}
                  onClick={() => setMode(value)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </fieldset>
          )}

          {mode === "default" && (
            <div className="space-y-2 rounded-lg border bg-muted/20 p-3 text-sm">
              <p>{summary(view)}</p>
              {view.effective.source === "custom" && canManage && (
                <Button
                  disabled={saving}
                  onClick={resetAll}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Use the org default for this workflow
                </Button>
              )}
              {view.org.unreachable && (
                <p className="text-destructive text-xs">
                  Nobody can be reached right now. Add an email or a channel in
                  notification settings.
                </p>
              )}
            </div>
          )}

          {mode === "custom" && canManage && (
            <div className="space-y-4 rounded-lg border p-3">
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="wf-failure-threshold">
                  Failed runs in a row
                </Label>
                <Input
                  className="h-8"
                  id="wf-failure-threshold"
                  inputMode="numeric"
                  onChange={(e) => setThreshold(e.target.value)}
                  placeholder={`Org default: ${view.org.threshold}`}
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
                      Org default (
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
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Email</Label>
                  <Button
                    className="h-auto px-0 text-xs"
                    onClick={() =>
                      setCustomRecipients(
                        customRecipients === null
                          ? [...view.org.recipientUserIds]
                          : null
                      )
                    }
                    type="button"
                    variant="link"
                  >
                    {customRecipients === null
                      ? "Choose for this workflow"
                      : "Use org list"}
                  </Button>
                </div>
                {customRecipients === null ? (
                  <p className="text-muted-foreground text-xs">
                    Org list:{" "}
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
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Channels</Label>
                  <Button
                    className="h-auto px-0 text-xs"
                    onClick={() =>
                      setCustomChannels(
                        customChannels === null
                          ? draftsFromViews(view.org.channels).map((c) => ({
                              ...c,
                              id: undefined,
                              key: `copy-${c.key}`,
                            }))
                          : null
                      )
                    }
                    type="button"
                    variant="link"
                  >
                    {customChannels === null
                      ? "Choose for this workflow"
                      : "Use org channels"}
                  </Button>
                </div>
                {customChannels === null ? (
                  <p className="text-muted-foreground text-xs">
                    Org channels:{" "}
                    {view.org.channels.length > 0
                      ? view.org.channels
                          .map(
                            (c) =>
                              `${CHANNEL_LABEL[c.kind]} ${c.kind === "discord" ? (c.connectionName ?? "") : c.destination}`
                          )
                          .join(", ")
                      : "none"}
                  </p>
                ) : (
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
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  className="h-auto px-0 text-xs"
                  disabled={saving}
                  onClick={resetAll}
                  type="button"
                  variant="link"
                >
                  Reset all to org default
                </Button>
                <span className="ml-auto flex gap-2">
                  <Button
                    onClick={() => apply(view)}
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
                </span>
              </div>
            </div>
          )}

          {mode === "muted" && (
            <div className="space-y-3 rounded-lg border border-yellow-500/40 p-3">
              {modeOf(view) === "muted" && (
                <p className="flex items-start gap-2 text-sm">
                  <BellOff
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0"
                  />
                  <span>
                    {view.override.muteUntilSuccess
                      ? "Muted until the next successful run"
                      : `Muted until ${new Date(view.override.mutedUntil ?? "").toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`}
                    {view.override.mutedBy
                      ? ` by ${view.override.mutedBy}`
                      : ""}
                    . Failures still show in Runs. If it is still failing when
                    the mute ends, alerts start again.
                  </span>
                </p>
              )}
              {canManage && (
                <>
                  <fieldset className="space-y-1.5">
                    <legend className="mb-1 text-xs">Mute until</legend>
                    {(
                      [
                        ["24h", "24 hours"],
                        ["7d", "7 days"],
                        ["success", "The next successful run"],
                        ["date", "A date and time"],
                      ] as const
                    ).map(([value, label]) => (
                      <label
                        className="flex items-center gap-2 text-sm"
                        htmlFor={`mute-${value}`}
                        key={value}
                      >
                        <input
                          checked={muteChoice === value}
                          id={`mute-${value}`}
                          name="mute-choice"
                          onChange={() => setMuteChoice(value)}
                          type="radio"
                        />
                        {label}
                      </label>
                    ))}
                    {muteChoice === "date" && (
                      <Input
                        aria-label="Mute end"
                        className="h-8"
                        max={maxDate}
                        min={toLocalInput(new Date())}
                        onChange={(e) => setMuteDate(e.target.value)}
                        type="datetime-local"
                        value={muteDate}
                      />
                    )}
                    <p className="text-muted-foreground text-xs">
                      Up to {MAX_MUTE_DAYS} days. A mute never lasts forever, so
                      a broken workflow cannot be forgotten.
                    </p>
                  </fieldset>
                  <div className="space-y-1.5">
                    <Label className="text-xs" htmlFor="mute-reason">
                      Reason (optional)
                    </Label>
                    <Input
                      className="h-8"
                      id="mute-reason"
                      maxLength={200}
                      onChange={(e) => setMuteReason(e.target.value)}
                      placeholder="Contract upgrade window"
                      value={muteReason}
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    {modeOf(view) === "muted" && (
                      <Button
                        disabled={saving}
                        onClick={unmute}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Unmute now
                      </Button>
                    )}
                    <Button
                      disabled={saving}
                      onClick={saveMute}
                      size="sm"
                      type="button"
                    >
                      {saving ? "Saving..." : "Mute alerts"}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      <div className="ml-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <Link
          className="underline-offset-4 hover:underline"
          href={settingsHref}
        >
          View org setting
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
