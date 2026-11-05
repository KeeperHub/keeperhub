"use client";

import { Loader2, Pause as PauseIcon, Play } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice, WARNING_TEXT } from "@/components/ui/notice";
import {
  type OrgSettingsView,
  orgPauseEffect,
} from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";
import { ChoiceChips } from "./choice-chips";
import { formatWhen, toLocalInput } from "./format";

type AlertsPause = NonNullable<OrgSettingsView["pause"]>;

const HOUR_MS = 60 * 60 * 1000;
const MAX_PAUSE_DAYS = 7;
const MAX_REASON = 200;

const CHOICES = [
  { value: "1", label: "1 hour" },
  { value: "4", label: "4 hours" },
  { value: "24", label: "24 hours" },
  { value: "custom", label: "Pick a time" },
] as const;

type Choice = (typeof CHOICES)[number]["value"];

/** The state at the top of Status: On, Paused or Off, with the pause control beside it. */
export function AlertsStatusBar({
  enabled,
  pause,
  pausingWorkflows,
  canManage,
  pausing,
  onPauseOpen,
  onResume,
}: {
  /** Alerts are switched on for the org (the rollout). */
  enabled: boolean;
  pause: AlertsPause | null;
  /** Workflows set to turn off at their limit. */
  pausingWorkflows: number;
  canManage: boolean;
  /** The pause form is open, so its button steps aside. */
  pausing: boolean;
  onPauseOpen: () => void;
  onResume: () => Promise<string | null>;
}): React.ReactElement {
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resume = async (): Promise<void> => {
    setResuming(true);
    setError(null);
    setError(await onResume());
    setResuming(false);
  };

  let mode: "on" | "paused" | "off" = "on";
  if (!enabled) {
    mode = "off";
  } else if (pause) {
    mode = "paused";
  }

  return (
    <div
      className="space-y-2"
      data-mode={mode}
      data-testid={mode === "paused" ? "failure-alerts-paused" : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 font-semibold text-sm",
            STATUS_PILL[mode]
          )}
          data-testid="failure-alerts-state"
        >
          <span
            aria-hidden="true"
            className={cn("size-2 rounded-full", STATUS_DOT[mode])}
          />
          {STATUS_LABEL[mode]}
        </span>
        <p className="min-w-0 flex-1 basis-64 text-sm">
          {mode === "on" &&
            "Failing workflows are reported by the rules and methods below."}
          {mode === "off" &&
            "Alerts are not switched on for this organization yet."}
          {mode === "paused" && pause && (
            <>
              Until {formatWhen(pause.until)}
              {pause.by ? ` by ${pause.by}` : ""}
              {pause.reason ? `: ${pause.reason}` : ""}.{" "}
              <span className="text-muted-foreground">
                {orgPauseEffect(pausingWorkflows)}
              </span>
            </>
          )}
        </p>
        {canManage && mode === "on" && !pausing && (
          <Button
            data-testid="failure-alerts-pause"
            onClick={onPauseOpen}
            size="sm"
            type="button"
            variant="outline"
          >
            <PauseIcon className="size-3.5" />
            Pause alerts
          </Button>
        )}
        {canManage && mode === "paused" && (
          <Button
            data-testid="failure-alerts-resume"
            disabled={resuming}
            onClick={resume}
            size="sm"
            type="button"
          >
            {resuming ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            Resume now
          </Button>
        )}
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

const STATUS_LABEL = { on: "On", paused: "Paused", off: "Off" } as const;
const STATUS_PILL = {
  on: "border-keeperhub-green/40 bg-keeperhub-green/10 text-keeperhub-green-dark",
  paused: WARNING_TEXT.concat(" bg-yellow-500/10"),
  off: "border-border bg-muted text-muted-foreground",
} as const;
const STATUS_DOT = {
  on: "bg-keeperhub-green-dark",
  paused: "bg-yellow-500",
  off: "bg-muted-foreground",
} as const;

/** How long and why, then Pause or Cancel. */
export function PauseAlertsForm({
  pausingWorkflows,
  onPause,
  onCancel,
}: {
  /** Workflows set to turn off at their limit. */
  pausingWorkflows: number;
  onPause: (body: { until: string; reason?: string }) => Promise<string | null>;
  onCancel: () => void;
}): React.ReactElement {
  const idPrefix = useId();
  const [choice, setChoice] = useState<Choice>("1");
  const [custom, setCustom] = useState("");
  // The browser picker only blocks whole days past max, so later times are snapped back.
  const [snapped, setSnapped] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const now = Date.now();
  const latest = now + MAX_PAUSE_DAYS * 24 * HOUR_MS;
  let until: Date | null = null;
  if (choice !== "custom") {
    until = new Date(now + Number(choice) * HOUR_MS);
  } else if (custom) {
    until = new Date(custom);
  }
  let invalid: string | null = null;
  if (choice === "custom" && until) {
    if (until.getTime() <= now) {
      invalid = "Pick a time in the future.";
    } else if (until.getTime() > latest) {
      invalid = `Alerts can be paused for at most ${MAX_PAUSE_DAYS} days.`;
    }
  }

  const pickCustom = (value: string): void => {
    const cap = Date.now() + MAX_PAUSE_DAYS * 24 * HOUR_MS;
    const over = Boolean(value) && new Date(value).getTime() > cap;
    // toLocalInput drops the seconds, so the snapped time stays inside the cap.
    setCustom(over ? toLocalInput(new Date(cap)) : value);
    setSnapped(over);
  };

  const submit = async (): Promise<void> => {
    if (!until || invalid) {
      return;
    }
    setSaving(true);
    setError(null);
    const trimmed = reason.trim();
    const refused = await onPause({
      until: until.toISOString(),
      reason: trimmed ? trimmed : undefined,
    });
    setSaving(false);
    setError(refused);
  };

  return (
    <div
      className="space-y-4 rounded-xl border bg-card/60 p-4 @xl/settings:p-5"
      data-testid="failure-alerts-pause-form"
    >
      <div className="space-y-1">
        <h2 className="font-semibold text-sm">Pause alerts</h2>
        <p className="text-muted-foreground text-xs">
          For maintenance, up to {MAX_PAUSE_DAYS} days.{" "}
          {orgPauseEffect(pausingWorkflows)}
        </p>
      </div>
      <div className="space-y-2">
        <ChoiceChips
          className="@xl/settings:grid-cols-4"
          legend="Pause for"
          onChange={setChoice}
          options={CHOICES}
          value={choice}
        />
        {choice === "custom" && (
          <Input
            aria-describedby={invalid ? `${idPrefix}-invalid` : undefined}
            aria-invalid={Boolean(invalid)}
            aria-label="Pause until"
            className="h-9 w-full @xl/settings:w-64"
            max={toLocalInput(new Date(latest))}
            min={toLocalInput(new Date(now))}
            onChange={(e) => pickCustom(e.target.value)}
            type="datetime-local"
            value={custom}
          />
        )}
        {choice === "custom" && snapped && !invalid && (
          <p className="text-muted-foreground text-xs">
            Moved to the latest time allowed, {MAX_PAUSE_DAYS} days from now.
          </p>
        )}
        {invalid && (
          <p className="text-destructive text-xs" id={`${idPrefix}-invalid`}>
            {invalid}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs" htmlFor={`${idPrefix}-reason`}>
          Reason (optional)
        </Label>
        <Input
          className="h-9"
          id={`${idPrefix}-reason`}
          maxLength={MAX_REASON}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Contract upgrade"
          value={reason}
        />
        <p className="text-muted-foreground text-xs">
          Shown on this page and in the pause email.
        </p>
      </div>
      {error && (
        <Notice role="alert" tone="danger">
          {error}
        </Notice>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="failure-alerts-pause-submit"
          disabled={saving || !until || Boolean(invalid)}
          onClick={submit}
          size="sm"
          type="button"
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Pause
        </Button>
        <Button onClick={onCancel} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
      </div>
    </div>
  );
}
