"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildCronFromSimple,
  describeCron,
  parseCronToSimple,
  validateCronExpression,
  type SimpleFrequency,
  type SimpleSchedule,
} from "@/lib/cron-utils";

const PRESETS: Record<string, { label: string; cron: string }> = {
  "every-15-min": { label: "Every 15 minutes", cron: "*/15 * * * *" },
  "every-30-min": { label: "Every 30 minutes", cron: "*/30 * * * *" },
  "every-hour": { label: "Every hour", cron: "0 * * * *" },
  "daily-9am": { label: "Every day at 9:00 AM", cron: "0 9 * * *" },
  "daily-midnight": { label: "Every day at midnight", cron: "0 0 * * *" },
  "weekdays-9am": { label: "Every weekday at 9:00 AM", cron: "0 9 * * 1-5" },
  "monday-9am": { label: "Every Monday at 9:00 AM", cron: "0 9 * * 1" },
} as const;

const CUSTOM_VALUE = "__custom__";

const DAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
] as const;

/**
 * KEEP-575: a Schedule trigger stores either a cron expression OR a true
 * "every N seconds" interval. The builder emits a discriminated value so
 * the parent component knows which field to persist.
 */
export type ScheduleBuilderValue =
  | { mode: "cron"; cron: string }
  | { mode: "interval"; intervalSeconds: number };

type CronScheduleBuilderProps = {
  value: { cron: string; intervalSeconds: number | null };
  onChange: (value: ScheduleBuilderValue) => void;
  disabled: boolean;
};

function findPresetKey(cron: string): string | undefined {
  for (const [key, preset] of Object.entries(PRESETS)) {
    if (preset.cron === cron) {
      return key;
    }
  }
  return undefined;
}

export function CronScheduleBuilder({
  value,
  onChange,
  disabled,
}: CronScheduleBuilderProps): React.ReactNode {
  const { cron: cronValue, intervalSeconds: intervalValue } = value;
  // KEEP-575: if the trigger config has an intervalSeconds stored, that's
  // the source of truth — open the simple-mode every-n-minutes UI seeded
  // from it, ignoring any stale synthetic cron stored alongside.
  const initialSimple = useMemo(() => {
    if (intervalValue !== null && intervalValue > 0) {
      return {
        frequency: "every-n-minutes" as const,
        interval: Math.max(1, Math.round(intervalValue / 60)),
      };
    }
    return parseCronToSimple(cronValue);
    // biome-ignore lint/correctness/useExhaustiveDependencies: only compute on mount
  }, []);

  const [tab, setTab] = useState<string>(
    cronValue && initialSimple === null ? "advanced" : "simple"
  );
  const [schedule, setSchedule] = useState<SimpleSchedule>(
    initialSimple ?? { frequency: "daily", hour: 9, minute: 0 }
  );
  const [advancedValue, setAdvancedValue] = useState(cronValue);
  const [isCustom, setIsCustom] = useState<boolean>(
    () =>
      initialSimple !== null &&
      (initialSimple.frequency === "every-n-minutes" ||
        findPresetKey(cronValue) === undefined)
  );

  // Sync external value changes into advanced mode
  useEffect(() => {
    setAdvancedValue(cronValue);
  }, [cronValue]);

  // Determine if current schedule matches a preset
  const currentPresetKey = useMemo(
    () => findPresetKey(cronValue),
    [cronValue]
  );

  // The select value: explicit custom flag takes priority over preset match
  const selectValue = isCustom ? CUSTOM_VALUE : (currentPresetKey ?? CUSTOM_VALUE);

  const emitSchedule = useCallback(
    (next: SimpleSchedule): void => {
      // KEEP-575: "every N minutes" is the only frequency that can need
      // interval mode — the others map cleanly to a cron expression.
      if (next.frequency === "every-n-minutes") {
        const interval = next.interval ?? 5;
        onChange({ mode: "interval", intervalSeconds: interval * 60 });
        return;
      }
      onChange({ mode: "cron", cron: buildCronFromSimple(next) });
    },
    [onChange]
  );

  const handleSelectChange = useCallback(
    (selected: string) => {
      if (selected === CUSTOM_VALUE) {
        setIsCustom(true);
        // Parse current value into schedule fields for editing
        const parsed = parseCronToSimple(cronValue);
        if (parsed !== null) {
          setSchedule(parsed);
        }
        return;
      }
      setIsCustom(false);
      const preset = PRESETS[selected];
      if (preset !== undefined) {
        const parsed = parseCronToSimple(preset.cron);
        if (parsed !== null) {
          setSchedule(parsed);
        }
        onChange({ mode: "cron", cron: preset.cron });
      }
    },
    [onChange, cronValue]
  );

  const updateSchedule = useCallback(
    (updates: Partial<SimpleSchedule>): void => {
      setSchedule((prev) => {
        const next = { ...prev, ...updates };
        emitSchedule(next);
        return next;
      });
    },
    [emitSchedule]
  );

  const handleAdvancedChange = useCallback(
    (input: string) => {
      setAdvancedValue(input);
      onChange({ mode: "cron", cron: input });
    },
    [onChange]
  );

  // KEEP-575: when interval mode is active, the cron column holds a
  // synthetic placeholder — show the user the true interval semantics
  // instead of the misleading cron description.
  const description =
    intervalValue !== null && intervalValue > 0
      ? `Every ${formatInterval(intervalValue)}`
      : describeCron(cronValue);
  const advancedValidation =
    tab === "advanced" && advancedValue
      ? validateCronExpression(advancedValue)
      : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Schedule</Label>
        <div className="flex gap-1 rounded-md border p-0.5">
          <button
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              tab === "simple"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab("simple")}
            type="button"
          >
            Simple
          </button>
          <button
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              tab === "advanced"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab("advanced")}
            type="button"
          >
            Advanced
          </button>
        </div>
      </div>

      {tab === "simple" && (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label className="ml-1" htmlFor="cron-schedule">
              Schedule
            </Label>
            <Select
              disabled={disabled}
              value={selectValue}
              onValueChange={handleSelectChange}
            >
              <SelectTrigger className="w-full" id="cron-schedule">
                <SelectValue placeholder="Select a schedule" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PRESETS).map(([key, preset]) => (
                  <SelectItem key={key} value={key}>
                    {preset.label}
                  </SelectItem>
                ))}
                <SelectSeparator />
                <SelectItem value={CUSTOM_VALUE}>Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {selectValue === CUSTOM_VALUE && (
            <>
              <div className="space-y-2">
                <Label className="ml-1" htmlFor="cron-frequency">
                  Frequency
                </Label>
                <Select
                  disabled={disabled}
                  value={schedule.frequency}
                  onValueChange={(val: string) =>
                    updateSchedule({ frequency: val as SimpleFrequency })
                  }
                >
                  <SelectTrigger className="w-full" id="cron-frequency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="every-minute">Every minute</SelectItem>
                    <SelectItem value="every-n-minutes">
                      Every N minutes
                    </SelectItem>
                    <SelectItem value="hourly">Hourly</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {schedule.frequency === "every-n-minutes" && (
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="cron-interval">
                    Interval (minutes)
                  </Label>
                  <Input
                    disabled={disabled}
                    id="cron-interval"
                    type="number"
                    min={1}
                    max={59}
                    value={schedule.interval ?? 5}
                    onChange={(e) => {
                      const parsed = Number.parseInt(e.target.value, 10);
                      if (
                        !Number.isNaN(parsed) &&
                        parsed >= 1 &&
                        parsed <= 59
                      ) {
                        updateSchedule({ interval: parsed });
                      }
                    }}
                  />
                </div>
              )}

              {schedule.frequency === "hourly" && (
                <div className="space-y-2">
                  <Label className="ml-1" htmlFor="cron-minute">
                    At minute
                  </Label>
                  <Input
                    disabled={disabled}
                    id="cron-minute"
                    type="number"
                    min={0}
                    max={59}
                    value={schedule.minute ?? 0}
                    onChange={(e) => {
                      const parsed = Number.parseInt(e.target.value, 10);
                      if (
                        !Number.isNaN(parsed) &&
                        parsed >= 0 &&
                        parsed <= 59
                      ) {
                        updateSchedule({ minute: parsed });
                      }
                    }}
                  />
                </div>
              )}

              {(schedule.frequency === "daily" ||
                schedule.frequency === "weekly") && (
                <TimeFields
                  disabled={disabled}
                  hour={schedule.hour ?? 9}
                  minute={schedule.minute ?? 0}
                  onUpdate={updateSchedule}
                />
              )}

              {schedule.frequency === "weekly" && (
                <DayOfWeekPicker
                  disabled={disabled}
                  daysOfWeek={schedule.daysOfWeek ?? []}
                  onUpdate={updateSchedule}
                />
              )}
            </>
          )}

          {selectValue !== CUSTOM_VALUE && (
            <DayOfWeekPicker
              disabled={disabled}
              daysOfWeek={schedule.daysOfWeek ?? []}
              onUpdate={(updates) => {
                const next = { ...schedule, ...updates };
                // When user toggles days on a preset, switch to weekly custom
                const hasSelectedDays =
                  updates.daysOfWeek !== undefined &&
                  updates.daysOfWeek.length > 0;
                if (hasSelectedDays) {
                  next.frequency = "weekly";
                }
                setSchedule(next);
                emitSchedule(next);
              }}
            />
          )}
        </div>
      )}

      {tab === "advanced" && (
        <div className="space-y-2">
          <Input
            disabled={disabled}
            id="cron-advanced"
            onChange={(e) => handleAdvancedChange(e.target.value)}
            placeholder="0 9 * * *"
            value={advancedValue}
          />
          {advancedValidation !== null && !advancedValidation.valid && (
            <p className="text-destructive text-xs">
              {advancedValidation.error}
            </p>
          )}
        </div>
      )}

      {description && (
        <p className="text-muted-foreground text-xs">Runs: {description}</p>
      )}
    </div>
  );
}

type DayOfWeekPickerProps = {
  disabled: boolean;
  daysOfWeek: number[];
  onUpdate: (updates: Partial<SimpleSchedule>) => void;
};

function DayOfWeekPicker({
  disabled,
  daysOfWeek,
  onUpdate,
}: DayOfWeekPickerProps): React.ReactNode {
  return (
    <div className="space-y-2">
      <Label className="ml-1">Days</Label>
      <div className="flex gap-2">
        {DAYS.map((day) => {
          const checked = daysOfWeek.includes(day.value);
          return (
            <label
              key={day.value}
              className="flex flex-col items-center gap-1 text-xs"
            >
              <span className="text-muted-foreground font-medium">
                {day.label}
              </span>
              <Checkbox
                disabled={disabled}
                checked={checked}
                onCheckedChange={(state) => {
                  const next =
                    state === true
                      ? [...daysOfWeek, day.value]
                      : daysOfWeek.filter((d) => d !== day.value);
                  onUpdate({ daysOfWeek: next });
                }}
              />
            </label>
          );
        })}
      </div>
      <p className="text-muted-foreground text-xs">
        Leave unchecked to run every day.
      </p>
    </div>
  );
}

type TimeFieldsProps = {
  disabled: boolean;
  hour: number;
  minute: number;
  onUpdate: (updates: Partial<SimpleSchedule>) => void;
};

// KEEP-575: format an interval (in seconds) as a human-readable string
// for the "Runs: ..." hint. Replaces the misleading "Every 55 minutes"
// description we used to show for the */55 cron.
function formatInterval(intervalSeconds: number): string {
  if (intervalSeconds < 60) {
    return `${intervalSeconds} second${intervalSeconds === 1 ? "" : "s"}`;
  }
  if (intervalSeconds < 3600) {
    const minutes = Math.round(intervalSeconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.round(intervalSeconds / 3600);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function TimeFields({
  disabled,
  hour,
  minute,
  onUpdate,
}: TimeFieldsProps): React.ReactNode {
  const timeValue = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  return (
    <div className="space-y-2">
      <Label className="ml-1" htmlFor="cron-time">
        Time
      </Label>
      <Input
        disabled={disabled}
        id="cron-time"
        type="time"
        value={timeValue}
        onChange={(e) => {
          const parts = e.target.value.split(":");
          if (parts.length === 2) {
            const h = Number.parseInt(parts[0], 10);
            const m = Number.parseInt(parts[1], 10);
            if (!Number.isNaN(h) && !Number.isNaN(m)) {
              onUpdate({ hour: h, minute: m });
            }
          }
        }}
      />
    </div>
  );
}
