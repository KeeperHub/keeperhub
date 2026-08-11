"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const FLYOUT_WIDTH = 280;
export const STRIP_WIDTH = 32;

type FlyoutPanelProps = {
  state: "open" | "collapsed" | "closed";
  leftOffset: number;
  title: string;
  collapsedLabel?: string;
  accentColor?: string;
  onCollapse: () => void;
  onExpand: () => void;
  children: React.ReactNode;
};

export function FlyoutPanel({
  state,
  leftOffset,
  title,
  collapsedLabel,
  accentColor,
  onCollapse,
  onExpand,
  children,
}: FlyoutPanelProps): React.ReactNode {
  if (state === "closed") {
    return null;
  }

  if (state === "collapsed") {
    const label = collapsedLabel ?? title;
    const dashIndex = label.indexOf(" - ");
    const category = dashIndex > -1 ? label.slice(0, dashIndex) : label;
    const selection = dashIndex > -1 ? label.slice(dashIndex + 3) : null;

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className="group pointer-events-auto fixed top-[calc(60px+var(--app-banner-height,0px))] bottom-0 z-30 flex items-start justify-center border-r bg-background pt-3 transition-[left,background-color,color] duration-200 ease-out hover:bg-card"
            data-flyout
            onClick={onExpand}
            style={{ left: leftOffset, width: STRIP_WIDTH }}
            type="button"
          >
            {accentColor && (
              <div
                className="absolute top-0 left-0 h-1 w-full"
                style={{ backgroundColor: accentColor }}
              />
            )}
            <div className="flex flex-col items-center gap-1.5">
              <ChevronRight className="size-3.5 text-muted-foreground transition-colors group-hover:text-foreground" />
              <div
                className="flex items-start gap-0.5 whitespace-nowrap"
                style={{ writingMode: "vertical-lr" }}
              >
                <span className="font-medium text-foreground/70 text-[10px] uppercase tracking-wider transition-colors group-hover:text-foreground">
                  {category}
                </span>
                {selection && (
                  <>
                    <span className="text-muted-foreground/40 text-[10px] transition-colors group-hover:text-muted-foreground">
                      /
                    </span>
                    <span className="max-h-[100px] overflow-hidden text-muted-foreground text-[11px] transition-colors group-hover:text-foreground">
                      {selection}
                    </span>
                  </>
                )}
              </div>
            </div>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <span className="text-xs">{label}</span>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div
      className={cn(
        "pointer-events-auto fixed top-[calc(60px+var(--app-banner-height,0px))] bottom-0 z-30 border-r bg-background shadow-lg transition-[left] duration-200 ease-out",
        "animate-[flyout-in_150ms_ease-out_forwards]"
      )}
      data-flyout
      role="menu"
      style={{ left: leftOffset, width: FLYOUT_WIDTH }}
    >
      <div className="flex h-full flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <span aria-hidden="true" className="size-6 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-center font-medium text-sm">
            {title}
          </span>
          <button
            className="size-6 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={onCollapse}
            title="Collapse"
            type="button"
          >
            <ChevronLeft className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">{children}</div>
      </div>
    </div>
  );
}
