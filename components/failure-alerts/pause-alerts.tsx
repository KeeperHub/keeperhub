"use client";

import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import type { OrgSettingsView } from "@/lib/notifications/failure-alerts/view-types";
import { cn } from "@/lib/utils";
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

/** The amber line at the top of Alerts while they are paused. */
export function AlertsPausedNotice({
  pause,
  canManage,
  onResume,
}: {
  pause: AlertsPause;
  canManage: boolean;
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

  return (
    <div data-testid="failure-alerts-paused">
      <Notice className="p-3 text-sm" role="status" tone="warning">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="min-w-0 flex-1 basis-64">
            Alerts are paused until {formatWhen(pause.until)}
            {pause.by ? ` by ${pause.by}` : ""}
            {pause.reason ? `: ${pause.reason}` : ""}. Workflows keep running;
            failures are recorded, but nobody is told until then.
          </p>
          {canManage && (
            <Button
              data-testid="failure-alerts-resume"
              disabled={resuming}
              onClick={resume}
              size="sm"
              type="button"
              variant="outline"
            >
              {resuming ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Resume now
            </Button>
          )}
        </div>
        {error && <p className="mt-2 text-destructive text-xs">{error}</p>}
      </Notice>
    </div>
  );
}

/** Until when and why, then Pause or Cancel. */
export function PauseAlertsForm({
  onPause,
  onCancel,
}: {
  onPause: (body: { until: string; reason?: string }) => Promise<string | null>;
  onCancel: () => void;
}): React.ReactElement {
  const idPrefix = useId();
  const [choice, setChoice] = useState<Choice>("1");
  const [custom, setCustom] = useState("");
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
          For maintenance: workflows keep running, but no alert goes out until
          then. Up to {MAX_PAUSE_DAYS} days.
        </p>
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-1.5 font-medium text-xs">Until</legend>
        <div className="grid grid-cols-2 gap-2 @xl/settings:grid-cols-4">
          {CHOICES.map((option) => (
            <label
              className={cn(
                "flex min-h-11 cursor-pointer items-center justify-center rounded-md border px-2 py-2 text-xs transition-colors hover:bg-muted/50 @xl/settings:min-h-9",
                "has-[:checked]:border-foreground/60 has-[:checked]:bg-muted",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50"
              )}
              htmlFor={`${idPrefix}-${option.value}`}
              key={option.value}
            >
              <input
                checked={choice === option.value}
                className="sr-only"
                id={`${idPrefix}-${option.value}`}
                name={`${idPrefix}-until`}
                onChange={() => setChoice(option.value)}
                type="radio"
                value={option.value}
              />
              {option.label}
            </label>
          ))}
        </div>
        {choice === "custom" && (
          <Input
            aria-describedby={invalid ? `${idPrefix}-invalid` : undefined}
            aria-invalid={Boolean(invalid)}
            aria-label="Pause until"
            className="h-9 w-full @xl/settings:w-64"
            max={toLocalInput(new Date(latest))}
            min={toLocalInput(new Date(now))}
            onChange={(e) => setCustom(e.target.value)}
            type="datetime-local"
            value={custom}
          />
        )}
        {invalid && (
          <p className="text-destructive text-xs" id={`${idPrefix}-invalid`}>
            {invalid}
          </p>
        )}
      </fieldset>
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
