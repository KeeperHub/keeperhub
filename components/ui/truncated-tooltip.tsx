"use client";

import type * as React from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type TruncatedTooltipProps = {
  /** Text to display (truncated) and show in full inside the tooltip. */
  text: string;
  /** Classes applied to the truncating span (the `truncate` class is added). */
  className?: string;
  side?: React.ComponentProps<typeof TooltipContent>["side"];
  tooltipClassName?: string;
};

/**
 * Single-line text that only reveals a tooltip with its full value when the
 * content is actually clipped. When the text fits, no tooltip is shown so
 * hovering a fully-visible label does nothing.
 */
export function TruncatedTooltip({
  text,
  className,
  side = "top",
  tooltipClassName,
}: TruncatedTooltipProps): React.ReactNode {
  const spanRef = useRef<HTMLSpanElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  const measure = useCallback(() => {
    const el = spanRef.current;
    if (el) {
      setIsTruncated(el.scrollWidth > el.clientWidth);
    }
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = spanRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("truncate", className)} ref={spanRef}>
          {text}
        </span>
      </TooltipTrigger>
      {isTruncated && (
        <TooltipContent className={tooltipClassName} side={side}>
          {text}
        </TooltipContent>
      )}
    </Tooltip>
  );
}
