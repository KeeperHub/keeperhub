"use client";

import { useAtom, useSetAtom } from "jotai";
import { CalendarDays } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  endOfDay,
  nextRangeStep,
  startOfDay,
} from "@/lib/analytics/date-range-selection";
import {
  analyticsCustomEndAtom,
  analyticsCustomStartAtom,
  analyticsRangeAtom,
} from "@/lib/atoms/analytics";
import { cn } from "@/lib/utils";

const DAY_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "long" });

// Where clearing lands, matching the range the page opens in.
const DEFAULT_RANGE = "24h" as const;

const NOOP = (): void => {
  // Selection is handled in onDayClick.
};

type Preset = { key: string; label: string; from: Date; to: Date };

/**
 * Whole calendar months back from this one, which is the shape of the ask:
 * "all of August" rather than "the last 31 days".
 */
function buildPresets(now: Date): Preset[] {
  const presets: Preset[] = [
    { key: "today", label: "Today", from: startOfDay(now), to: endOfDay(now) },
  ];
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  presets.push({
    key: "yesterday",
    label: "Yesterday",
    from: startOfDay(yesterday),
    to: endOfDay(yesterday),
  });

  for (let back = 0; back < 4; back += 1) {
    const first = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const last = new Date(now.getFullYear(), now.getMonth() - back + 1, 0);
    presets.push({
      key: `month-${back}`,
      label: back === 0 ? "This month" : MONTH_LABEL.format(first),
      from: startOfDay(first),
      to: endOfDay(last),
    });
  }
  return presets;
}

/**
 * Arbitrary windows, alongside the preset buttons rather than replacing them.
 * Choosing here switches the range to `custom`; choosing a preset button
 * clears the dates again.
 */
export function DateRangeFilter(): ReactNode {
  const [range, setRange] = useAtom(analyticsRangeAtom);
  const [customStart, setCustomStart] = useAtom(analyticsCustomStartAtom);
  const setCustomEnd = useSetAtom(analyticsCustomEndAtom);
  const [customEnd] = useAtom(analyticsCustomEndAtom);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);

  const presets = useMemo(() => buildPresets(new Date()), []);

  // Applying deliberately leaves the popover open. Picking a window is often
  // several attempts at the same question, and closing on the second click cost
  // a reopen every time. It closes on a click outside or on Escape, like any
  // other popover.
  const apply = useCallback(
    (from: Date, to: Date): void => {
      setCustomStart(from.toISOString());
      setCustomEnd(to.toISOString());
      setRange("custom");
      setDraft(undefined);
    },
    [setCustomStart, setCustomEnd, setRange]
  );

  /**
   * Selection is driven from the raw day click rather than the library's range
   * accumulation. Handed an already-committed range as its current value, that
   * accumulation reads the next click as closing that range, so it reported
   * both ends at once and the popover applied and shut on every single click.
   *
   * Here the first click after opening always starts a new range and the second
   * closes it, whatever was selected before.
   */
  const onDayClick = useCallback(
    (day: Date): void => {
      const step = nextRangeStep(draft, day);
      if (step.kind === "start") {
        setDraft({ from: step.from, to: undefined });
        return;
      }
      apply(step.from, step.to);
    },
    [draft, apply]
  );

  const active = range === "custom" && customStart !== null;

  const label = useMemo((): string => {
    if (!(active && customStart && customEnd)) {
      return "Custom";
    }
    const from = new Date(customStart);
    const to = new Date(customEnd);
    const sameDay = from.toDateString() === to.toDateString();
    return sameDay
      ? DAY_LABEL.format(from)
      : `${DAY_LABEL.format(from)} - ${DAY_LABEL.format(to)}`;
  }, [active, customStart, customEnd]);

  const selected = useMemo((): DateRange | undefined => {
    if (draft) {
      return draft;
    }
    if (!(active && customStart)) {
      return undefined;
    }
    return {
      from: new Date(customStart),
      to: customEnd ? new Date(customEnd) : undefined,
    };
  }, [draft, active, customStart, customEnd]);

  // Drops the hand-picked window and falls back to the default preset, which is
  // the state the page opens in. Without this the only way out of a custom
  // range is to pick a preset, which is not obviously a way out.
  const clear = useCallback((): void => {
    setCustomStart(null);
    setCustomEnd(null);
    setRange(DEFAULT_RANGE);
    setDraft(undefined);
  }, [setCustomStart, setCustomEnd, setRange]);

  const onOpenChange = useCallback((next: boolean): void => {
    setOpen(next);
    if (!next) {
      setDraft(undefined);
    }
  }, []);

  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label="Custom date range"
          className={cn("gap-1.5", active && "border-primary/40")}
          size="sm"
          variant={active ? "default" : "outline"}
        >
          <CalendarDays className="size-4" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-auto gap-0 p-0">
        <div className="flex w-36 flex-col gap-0.5 border-r p-2">
          {presets.map((preset) => (
            <Button
              className="h-7 justify-start px-2 text-xs"
              key={preset.key}
              onClick={() => apply(preset.from, preset.to)}
              size="sm"
              variant="ghost"
            >
              {preset.label}
            </Button>
          ))}
          <div className="mt-1 border-t pt-1">
            <Button
              className="h-7 w-full justify-start px-2 text-muted-foreground text-xs"
              disabled={!active}
              onClick={clear}
              size="sm"
              variant="ghost"
            >
              Clear range
            </Button>
          </div>
        </div>
        <Calendar
          defaultMonth={selected?.from}
          mode="range"
          numberOfMonths={2}
          onDayClick={onDayClick}
          // Required by the range mode's types; the click handler above owns
          // the transitions, so this deliberately does nothing.
          onSelect={NOOP}
          selected={selected}
        />
      </PopoverContent>
    </Popover>
  );
}
