"use client";

import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice, WARNING_TEXT } from "@/components/ui/notice";
import { Switch } from "@/components/ui/switch";
import { actorLabel } from "@/lib/notifications/failure-alerts/actor-label";
import {
  type OrgSettingsView,
  orgPauseEffect,
} from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";
import { ChoiceChips } from "./choice-chips";
import { TextWithEmails } from "./email-text";
import { formatWhen, toLocalInput } from "./format";

type AlertsPause = NonNullable<OrgSettingsView["pause"]>;

const HOUR_MS = 60 * 60 * 1000;

const MAX_PAUSE_DAYS = 7;
const MAX_REASON = 200;

/** "Paused by Dana (dana@x.com)", or by the account when the name is only a role. */
function pauseAuthor(pause: AlertsPause): string {
  const who = actorLabel(pause.by, pause.byAccount);
  return who ? `Paused by ${who}` : "Paused";
}

const CHOICES = [
  { value: "1", label: "1 hour" },
  { value: "4", label: "4 hours" },
  { value: "24", label: "24 hours" },
  { value: "custom", label: "Pick a time" },
] as const;

type Choice = (typeof CHOICES)[number]["value"];

const MINUTE_MS = 60 * 1000;

/** "in 42 minutes", "in 5 hours", "in 2 days". */
function timeLeft(ms: number): string {
  if (ms < HOUR_MS) {
    const minutes = Math.max(1, Math.ceil(ms / MINUTE_MS));
    return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (ms < 48 * HOUR_MS) {
    const hours = Math.round(ms / HOUR_MS);
    return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `in ${Math.round(ms / (24 * HOUR_MS))} days`;
}

/**
 * On or Paused, and the switch: turning it off opens the pause form (it stays
 * on until the pause is confirmed); turning it on resumes at once.
 */
export function AlertsSwitch({
  paused,
  canManage,
  busy,
  onPause,
  onResume,
}: {
  paused: boolean;
  canManage: boolean;
  /** A pause or resume is saving, or the pause form is open. */
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          "font-semibold text-sm",
          paused ? WARNING_TEXT : "text-keeperhub-green-dark"
        )}
        data-testid="failure-alerts-state"
      >
        {paused ? "Paused" : "On"}
      </span>
      <Switch
        aria-label={
          paused ? "Alerts paused. Turn on to resume now" : "Alerts on"
        }
        checked={!paused}
        data-testid="failure-alerts-switch"
        disabled={!canManage || busy}
        onCheckedChange={(on) => (on ? onResume() : onPause())}
      />
    </div>
  );
}

/** Under the switch: what On means, or the pause's end, who and why. */
export function AlertsStateBody({
  pause,
  pausingWorkflows,
  canManage,
  onExtend,
  error,
  now = Date.now(),
}: {
  pause: AlertsPause | null;
  /** Workflows set to turn off at their limit. */
  pausingWorkflows: number;
  canManage: boolean;
  onExtend: () => void;
  error: string | null;
  now?: number;
}): React.ReactElement {
  const errorLine = error && (
    <p className="text-destructive text-xs" role="alert">
      {error}
    </p>
  );
  if (!pause) {
    return (
      <div className="space-y-1">
        <p className="text-sm">
          On: failing workflows are reported using the rules and methods in
          Setup.
        </p>
        {!canManage && (
          <p className="text-muted-foreground text-xs">
            Only owners and admins can pause alerts.
          </p>
        )}
        {errorLine}
      </div>
    );
  }
  const left = new Date(pause.until).getTime() - now;
  const at = new Date(pause.until).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div className="space-y-1.5" data-testid="failure-alerts-paused">
      <p className={cn("font-semibold text-sm", WARNING_TEXT)}>
        {left < HOUR_MS
          ? `Resumes ${timeLeft(left)} (${at})`
          : `Resumes ${formatWhen(pause.until)} (${timeLeft(left)})`}
      </p>
      <p className="text-sm">
        <TextWithEmails text={pauseAuthor(pause)} />
        {pause.reason ? `: ${pause.reason}` : ""}.{" "}
        <span className="text-muted-foreground">
          {orgPauseEffect(pausingWorkflows)}
        </span>
      </p>
      {canManage ? (
        <Button
          className="h-auto px-0 text-xs underline underline-offset-4"
          data-testid="failure-alerts-extend"
          onClick={onExtend}
          type="button"
          variant="link"
        >
          Extend or change the pause
        </Button>
      ) : (
        <p className="text-muted-foreground text-xs">
          Only owners and admins can resume alerts.
        </p>
      )}
      {errorLine}
    </div>
  );
}

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
