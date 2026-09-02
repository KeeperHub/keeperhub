"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { DayPicker } from "react-day-picker";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Calendar surface for the app. Every class here comes from the design tokens
 * rather than react-day-picker's own stylesheet, so a day cell rounds, hovers
 * and highlights exactly like a row in any other popover: `rounded-md` for the
 * control radius, `bg-accent` for hover, `bg-primary` for the chosen day.
 */
export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: ComponentProps<typeof DayPicker>): ReactNode {
  return (
    <DayPicker
      className={cn("p-3", className)}
      classNames={{
        months: "relative flex flex-col gap-4 sm:flex-row",
        month: "flex flex-col gap-4",
        month_caption: "flex h-7 items-center justify-center px-8",
        caption_label: "font-medium text-sm",
        // The nav is one element for the whole grid, so it spans the months
        // and pins to their top edge. Positioning the buttons individually let
        // them fall to wherever the nav happened to flow, which was on top of
        // the first week's dates.
        nav: "absolute inset-x-0 top-0 flex items-center justify-between",
        button_previous: cn(
          buttonVariants({ variant: "ghost" }),
          "size-7 p-0 opacity-60 hover:opacity-100"
        ),
        button_next: cn(
          buttonVariants({ variant: "ghost" }),
          "size-7 p-0 opacity-60 hover:opacity-100"
        ),
        month_grid: "w-full border-collapse space-y-1",
        weekdays: "flex",
        weekday:
          "w-8 rounded-md font-normal text-[0.7rem] text-muted-foreground",
        week: "mt-1 flex w-full",
        // v10 puts these modifier classes on the day cell, not on its button.
        // So the cell carries the band and the button carries the pill: the
        // ends round because the button rounds, and the middle stays flat so a
        // run of days reads as one continuous band rather than separate chips.
        day: "relative p-0 text-center text-sm",
        day_button:
          "size-8 rounded-md p-0 font-normal transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected:
          "[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground",
        range_start: "rounded-l-md",
        range_end: "rounded-r-md",
        range_middle:
          "bg-accent [&>button]:bg-transparent [&>button]:text-accent-foreground [&>button]:hover:bg-transparent",
        today: "[&>button]:ring-1 [&>button]:ring-primary",
        outside: "text-muted-foreground/60",
        disabled: "text-muted-foreground opacity-50",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? (
            <ChevronLeft className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          ),
      }}
      showOutsideDays={showOutsideDays}
      {...props}
    />
  );
}
