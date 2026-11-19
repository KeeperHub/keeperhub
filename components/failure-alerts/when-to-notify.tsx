"use client";

import { ChevronRight } from "lucide-react";
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
  DEFAULT_TIME_LIMIT_MINUTES,
  MAX_REMINDERS,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  MIN_TIME_RULE_FAILURES,
  REFUSED_RUNS_THRESHOLD,
  TIME_LIMIT_OPTIONS_MINUTES,
} from "@/lib/notifications/failure-alerts/constants";
import { timeLimitLabel } from "./format";

/** The rules every method follows. The threshold is held as typed. */
export type RulesDraft = {
  threshold: string;
  timeLimitMinutes: number | null;
  remindDaily: boolean;
  notifyRecovery: boolean;
};

type SavedRules = Omit<RulesDraft, "threshold"> & { threshold: number };

export function rulesDraftFrom(rules: SavedRules): RulesDraft {
  return { ...rules, threshold: String(rules.threshold) };
}

export function isValidThreshold(value: string): boolean {
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

/** Moves each field still at its old saved value to the new one; edited fields stay. */
export function rebaseRules(
  draft: RulesDraft,
  before: SavedRules,
  after: SavedRules
): RulesDraft {
  const old = rulesDraftFrom(before);
  const next = rulesDraftFrom(after);
  const rebased: RulesDraft = {
    threshold:
      draft.threshold.trim() === old.threshold
        ? next.threshold
        : draft.threshold,
    timeLimitMinutes:
      draft.timeLimitMinutes === old.timeLimitMinutes
        ? next.timeLimitMinutes
        : draft.timeLimitMinutes,
    remindDaily:
      draft.remindDaily === old.remindDaily
        ? next.remindDaily
        : draft.remindDaily,
    notifyRecovery:
      draft.notifyRecovery === old.notifyRecovery
        ? next.notifyRecovery
        : draft.notifyRecovery,
  };
  // The same object when nothing moved, so an unrelated save re-arms no autosave.
  const same = (Object.keys(rebased) as (keyof RulesDraft)[]).every(
    (key) => rebased[key] === draft[key]
  );
  return same ? draft : rebased;
}

/** The rules every method follows; the page saves them. */
export function WhenToNotify({
  draft,
  saved,
  canManage,
  onChange,
}: {
  draft: RulesDraft;
  saved: SavedRules;
  canManage: boolean;
  onChange: (next: RulesDraft) => void;
}): React.ReactElement {
  const disabled = !canManage;
  const invalid = !isValidThreshold(draft.threshold);
  const runs = invalid ? saved.threshold : Number(draft.threshold);

  const change = (patch: Partial<RulesDraft>): void => {
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
              timeLimitMinutes:
                checked === true ? DEFAULT_TIME_LIMIT_MINUTES : null,
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
          value={String(draft.timeLimitMinutes ?? DEFAULT_TIME_LIMIT_MINUTES)}
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
                {timeLimitLabel(minutes)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <details className="group text-xs" data-testid="failure-alerts-rule-help">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground sm:min-h-0">
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
          How failures are counted
        </summary>
        <ul className="mt-2 space-y-1 text-muted-foreground text-xs">
          <li>
            <span className="font-medium text-foreground">
              Failed runs in a row:
            </span>{" "}
            the alert goes out after this many failures in a row. A workflow
            that runs every 4 hours takes {4 * runs} hours to reach {runs}.
          </li>
          <li>
            <span className="font-medium text-foreground">Time limit:</span> for
            slow schedules, the alert goes out once it has been failing this
            long, with at least {MIN_TIME_RULE_FAILURES} failures in a row.
          </li>
          <li>
            <span className="font-medium text-foreground">Out of funds:</span> a
            wallet that runs out of funds alerts after 2 failed runs, whatever
            the limits.
          </li>
          <li>
            <span className="font-medium text-foreground">Refused runs</span>{" "}
            (plan limit, billing, paid features): reported after{" "}
            {REFUSED_RUNS_THRESHOLD} refusals, and again when runs are accepted.
          </li>
          <li>
            <span className="font-medium text-foreground">Never counted:</span>{" "}
            errors on KeeperHub's side, and workflows that are turned off.
          </li>
        </ul>
      </details>
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
    </div>
  );
}
