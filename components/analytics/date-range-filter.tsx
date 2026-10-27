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
import { BELOW_SM_QUERY, useMediaQuery } from "@/hooks/use-mobile";
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

// The page's p-6. Below sm the popover keeps this clear of both screen edges,
// so it lines up with the header above it; its width, calc(100vw-3rem), is the
// same 24px taken off each side.
const PHONE_EDGE_GAP = 24;

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
  // Below sm the popover takes the screen's width less the page margins (up to
  // max-w-sm) rather than its contents' width, so it shows one month under a
  // wrapped row of presets. The preset column beside two stacked months ran
  // past the right edge at 320px and stood taller than most phones.
  const narrow = useMediaQuery(BELOW_SM_QUERY);

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
      <PopoverContent
        align="end"
        className="flex max-h-(--radix-popover-content-available-height) w-[calc(100vw-3rem)] max-w-sm flex-col gap-0 overflow-y-auto p-0 sm:w-auto sm:max-w-none sm:flex-row"
        // Phones only: from sm the popover is 634px wide, and 24px each side
        // would push it off a 640px screen, where it used to fit.
        collisionPadding={narrow ? PHONE_EDGE_GAP : 0}
      >
        <div className="flex flex-wrap gap-1 border-b p-2 sm:w-36 sm:flex-col sm:flex-nowrap sm:gap-0.5 sm:border-r sm:border-b-0">
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
          {/* On phones the end of the last row, apart from the dates. */}
          <div className="ml-auto sm:mt-1 sm:ml-0 sm:border-t sm:pt-1">
            <Button
              className="h-7 justify-start px-2 text-muted-foreground text-xs sm:w-full"
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
          className="self-center sm:self-auto"
          defaultMonth={selected?.from}
          mode="range"
          numberOfMonths={narrow ? 1 : 2}
          onDayClick={onDayClick}
          // Required by the range mode's types; the click handler above owns
          // the transitions, so this deliberately does nothing.
          onSelect={NOOP}
          selected={selected}
          // Two months side by side each pad their grid with the neighbour's
          // days, so the end of September appeared in both panels, once as its
          // own date and once as October's padding - and a selected range lit
          // up in both places.
          showOutsideDays={false}
        />
      </PopoverContent>
    </Popover>
  );
}
