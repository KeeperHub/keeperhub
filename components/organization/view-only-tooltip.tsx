"use client";

import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { VIEWER_DISABLED_REASON } from "@/lib/organization/role-label";
import { cn } from "@/lib/utils";

/**
 * Explains why a disabled control cannot be used. A disabled button emits no
 * pointer events, so the tooltip hangs off a wrapping span. Renders the
 * children untouched when there is no reason.
 */
export function DisabledReasonTooltip({
  reason,
  children,
  className,
}: {
  reason: string | null | undefined;
  children: ReactNode;
  className?: string;
}): ReactNode {
  if (!reason) {
    return children;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-block", className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/** Tooltip for a write control a viewer sees but cannot use. */
export function ViewOnlyTooltip({
  isViewer,
  children,
  className,
}: {
  isViewer: boolean;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <DisabledReasonTooltip
      className={className}
      reason={isViewer ? VIEWER_DISABLED_REASON : undefined}
    >
      {children}
    </DisabledReasonTooltip>
  );
}
