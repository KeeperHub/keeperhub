"use client";

import { useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { settingsAnchor } from "./nav";

/**
 * A card names one setting, so the rail search can deep link straight to it:
 * `?highlight=<anchor>` scrolls it into view and rings it briefly.
 */
function useHighlight(title: string | undefined): {
  ref: React.RefObject<HTMLElement | null>;
  lit: boolean;
} {
  const params = useSearchParams();
  const ref = useRef<HTMLElement>(null);
  const [lit, setLit] = useState(false);
  const target = title ? settingsAnchor(title) : null;
  const wanted = params.get("highlight");

  useEffect(() => {
    // Cards stay mounted while you click through several entries in the same
    // section, so a card that is no longer the target has to drop its ring
    // rather than just skip the effect.
    if (!(target && wanted) || target !== wanted) {
      setLit(false);
      return;
    }
    ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    setLit(true);
    const timer = window.setTimeout(() => setLit(false), 2200);
    // Clearing the timer on an early navigation would otherwise leave the ring
    // on for good, so drop it here too.
    return () => {
      window.clearTimeout(timer);
      setLit(false);
    };
  }, [target, wanted]);

  return { lit, ref };
}

export function SectionHeader({
  title,
  description,
  action,
  leading,
}: {
  title: string;
  /** A node, so a page still waiting for it can hold the line open. */
  description?: ReactNode;
  action?: ReactNode;
  /** Sits to the left of the title, for the way back out of a subpage. */
  leading?: ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      {/* Aligned to the title's line, not to the middle of the block: with a
          second line under the title the control sat between the two. */}
      <div className="flex min-w-0 items-start gap-3">
        {leading}
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="font-bold text-2xl tracking-tight">{title}</h1>
          {description && (
            <p className="max-w-xl text-muted-foreground text-sm">
              {description}
            </p>
          )}
        </div>
      </div>
      {action}
    </div>
  );
}

export function SettingsCard({
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}): React.ReactElement {
  const { ref, lit } = useHighlight(title);
  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border bg-card/60 backdrop-blur-sm transition-shadow duration-300",
        lit && "ring-2 ring-foreground/30",
        className
      )}
      id={title ? settingsAnchor(title) : undefined}
      ref={ref}
    >
      {/* Centred, and the words hold a width of their own: a long description
          used to push the controls onto a line of their own and leave them
          pinned to the top of it. */}
      {title && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="font-semibold text-sm">{title}</h2>
            {description && (
              <p className="max-w-2xl text-muted-foreground text-xs">
                {description}
              </p>
            )}
          </div>
          {/* The actions keep their size and drop to their own line rather
              than being pushed past the card's edge on a narrow screen. */}
          {action && <div className="flex shrink-0 items-center">{action}</div>}
        </header>
      )}
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * Keeps the element and its type styles and only hides the words, so a
 * placeholder occupies exactly the line box the real text will. A separate
 * skeleton with its own heights cannot promise that.
 */
export const VEILED =
  "animate-pulse select-none rounded bg-muted text-transparent";

export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  loading = false,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "accent" | "warning";
  loading?: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border bg-card/60 p-4">
      <span
        className={cn("w-fit text-muted-foreground text-xs", loading && VEILED)}
      >
        {loading ? "Loading label" : label}
      </span>
      <span
        className={cn(
          "w-fit font-bold text-xl tabular-nums",
          loading && VEILED
        )}
      >
        {loading ? "0000" : value}
      </span>
      {(hint || loading) && (
        <span
          className={cn(
            "w-fit text-xs",
            tone === "accent" && "text-foreground",
            tone === "warning" && "text-amber-400",
            tone === "neutral" && "text-muted-foreground",
            loading && VEILED
          )}
        >
          {loading ? "Loading hint text" : hint}
        </span>
      )}
    </div>
  );
}

/**
 * Holds roughly the height of the skeleton it replaces, so a card that turns
 * out to be empty does not collapse the moment its request lands.
 */
export function EmptyState({
  children,
}: {
  children: string;
}): React.ReactElement {
  return (
    <p className="flex min-h-32 items-center justify-center text-center text-muted-foreground text-sm">
      {children}
    </p>
  );
}

/**
 * Row styling for every table in the settings hub.
 *
 * The divider sits on the row's own bottom edge, so the default full-height
 * hover fill would run straight into it. Instead the fill is drawn by an inset
 * pseudo-element on each cell -- 3px clear of the row box top and bottom -- so
 * it reads as a rounded band floating between the separators. `isolate` keeps
 * the `-z-10` fill behind the cell's own content.
 */
export const SETTINGS_ROW = [
  "border-border/60 hover:bg-transparent",
  "[&>td]:relative [&>td]:isolate [&>td]:py-3.5",
  "[&>td]:before:absolute [&>td]:before:inset-x-0 [&>td]:before:inset-y-[3px]",
  "[&>td]:before:-z-10 [&>td]:before:bg-transparent",
  "[&>td]:before:transition-colors [&>td]:before:content-['']",
  "[&:hover>td]:before:bg-muted/50",
  "[&>td:first-child]:before:rounded-l-lg [&>td:last-child]:before:rounded-r-lg",
].join(" ");

/** Header row: same horizontal rhythm as the body, a touch more air below. */
// A header is not a row anyone can act on, so it does not light up under the
// pointer the way the rows below it do.
export const SETTINGS_HEAD_ROW =
  "border-border/60 hover:bg-transparent [&>th]:h-9 [&>th]:pb-2";
