"use client";

import { Info } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * A field label with the explanation behind an icon.
 *
 * Policy vocabulary is precise and unfamiliar, so a field name alone rarely
 * says what it decides. Keeping the explanation in a tooltip means it is there
 * when it is needed without a paragraph under every input.
 */
export function FieldLabel({
  htmlFor,
  children,
  hint,
}: {
  htmlFor?: string;
  children: React.ReactNode;
  hint: string;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor}>{children}</Label>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={hint}
            className="text-muted-foreground hover:text-foreground"
            type="button"
          >
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{hint}</TooltipContent>
      </Tooltip>
    </div>
  );
}
