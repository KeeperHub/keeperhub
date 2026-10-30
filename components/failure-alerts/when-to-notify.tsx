"use client";

import { Loader2 } from "lucide-react";
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
  MAX_REMINDERS,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  TIME_LIMIT_OPTIONS_MINUTES,
} from "@/lib/notifications/failure-alerts/constants";
import { FUNDS_RULE } from "./format";
import {
  type SaveAction,
  SaveError,
  SaveFeedback,
  useSaveState,
} from "./save-state";

/** The rules every method follows. The threshold is held as typed. */
export type RulesDraft = {
  threshold: string;
  timeLimitMinutes: number | null;
  remindDaily: boolean;
  notifyRecovery: boolean;
};

type SavedRules = Omit<RulesDraft, "threshold"> & { threshold: number };

const TIME_LIMIT_LABEL: Record<number, string> = {
  60: "1 hour",
  360: "6 hours",
  1440: "24 hours",
};
const DEFAULT_TIME_LIMIT = 360;

export function rulesDraftFrom(rules: SavedRules): RulesDraft {
  return { ...rules, threshold: String(rules.threshold) };
}

function isValidThreshold(value: string): boolean {
  const n = Number(value);
  return (
    value.trim() !== "" &&
    Number.isInteger(n) &&
    n >= MIN_THRESHOLD &&
    n <= MAX_THRESHOLD
  );
}

export function rulesDirty(draft: RulesDraft, saved: SavedRules): boolean {
  return (
    draft.threshold.trim() !== String(saved.threshold) ||
    draft.timeLimitMinutes !== saved.timeLimitMinutes ||
    draft.remindDaily !== saved.remindDaily ||
    draft.notifyRecovery !== saved.notifyRecovery
  );
}

/** The rules for every method, with their own Save. */
export function WhenToNotify({
  draft,
  saved,
  canManage,
  onChange,
  onSave,
  onReload,
}: {
  draft: RulesDraft;
  saved: SavedRules;
  canManage: boolean;
  onChange: (next: RulesDraft) => void;
  onSave: SaveAction;
  onReload?: () => void;
}): React.ReactElement {
  const save = useSaveState();
  const disabled = !canManage;
  const invalid = !isValidThreshold(draft.threshold);
  const dirty = rulesDirty(draft, saved);
  const runs = invalid ? saved.threshold : Number(draft.threshold);

  const change = (patch: Partial<RulesDraft>): void => {
    save.reset();
    onChange({ ...draft, ...patch });
  };

  return (
    <div className="space-y-3 text-sm" data-testid="failure-alerts-rules">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="font-normal" htmlFor="failure-threshold">
          Alert after
        </Label>
        <Input
          aria-describedby={invalid ? "failure-threshold-error" : undefined}
          aria-invalid={invalid}
          className="h-9 w-16"
          disabled={disabled}
          id="failure-threshold"
          inputMode="numeric"
          max={MAX_THRESHOLD}
          min={MIN_THRESHOLD}
          onChange={(e) => change({ threshold: e.target.value })}
          type="number"
          value={draft.threshold}
        />
        <span>failed runs in a row</span>
      </div>
      {invalid && (
        <p className="text-destructive text-xs" id="failure-threshold-error">
          Use a whole number from {MIN_THRESHOLD} to {MAX_THRESHOLD}.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Checkbox
          checked={draft.timeLimitMinutes !== null}
          disabled={disabled}
          id="failure-time-limit"
          onCheckedChange={(checked) =>
            change({
              timeLimitMinutes: checked === true ? DEFAULT_TIME_LIMIT : null,
            })
          }
        />
        <Label className="font-normal" htmlFor="failure-time-limit">
          or when it has been failing for
        </Label>
        <Select
          disabled={disabled || draft.timeLimitMinutes === null}
          key={draft.timeLimitMinutes === null ? "off" : "on"}
          onValueChange={(v) => change({ timeLimitMinutes: Number(v) })}
          value={String(draft.timeLimitMinutes ?? DEFAULT_TIME_LIMIT)}
        >
          <SelectTrigger aria-label="How long" className="h-9 w-28" size="sm">
            {draft.timeLimitMinutes === null ? (
              <span className="text-muted-foreground">Off</span>
            ) : (
              <SelectValue />
            )}
          </SelectTrigger>
          <SelectContent>
            {TIME_LIMIT_OPTIONS_MINUTES.map((minutes) => (
              <SelectItem key={minutes} value={String(minutes)}>
                {TIME_LIMIT_LABEL[minutes]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-muted-foreground text-xs">
        For slow schedules: a workflow that runs every 4 hours takes {4 * runs}{" "}
        hours to fail {runs} time{runs === 1 ? "" : "s"}.
      </p>
      <p className="text-muted-foreground text-xs">{FUNDS_RULE}</p>
      <label className="flex items-center gap-2" htmlFor="failure-remind">
        <Checkbox
          checked={draft.remindDaily}
          disabled={disabled}
          id="failure-remind"
          onCheckedChange={(checked) =>
            change({ remindDaily: checked === true })
          }
        />
        Remind once a day while it keeps failing (up to {MAX_REMINDERS} days)
      </label>
      <label className="flex items-center gap-2" htmlFor="failure-recovery">
        <Checkbox
          checked={draft.notifyRecovery}
          disabled={disabled}
          id="failure-recovery"
          onCheckedChange={(checked) =>
            change({ notifyRecovery: checked === true })
          }
        />
        Tell people when it works again
      </label>
      <SaveError
        error={save.error}
        onReload={
          onReload
            ? () => {
                save.reset();
                onReload();
              }
            : undefined
        }
      />
      {canManage && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button
            aria-label="Save rules"
            disabled={!dirty || invalid || save.state === "saving"}
            onClick={() => save.run(onSave)}
            size="sm"
            type="button"
          >
            {save.state === "saving" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : null}
            Save
          </Button>
          <SaveFeedback
            dirty={dirty}
            state={save.state}
            testId="failure-alerts-rules-save"
          />
        </div>
      )}
    </div>
  );
}
