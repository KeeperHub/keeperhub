"use client";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type FieldToolbarButtonProps = {
  /** Names the action for assistive technology; the button shows only an icon. */
  label: string;
  /** What the button does, shown on hover and focus. */
  tooltip: string;
  onClick: () => void;
  /**
   * A toggle that is on. It stays green whether or not it is hovered, so the
   * hover highlight never reads as the toggle having switched off.
   */
  active?: boolean;
  children: React.ReactNode;
};

/**
 * Icon button for the strip along the top of a config field, beside Beautify.
 *
 * It shares Beautify's states so the strip reads as one control: grey icon at
 * rest, a grey background with a white icon on hover. A toggle that is on adds
 * a green state, with a stronger green on hover.
 */
export function FieldToolbarButton({
  label,
  tooltip,
  onClick,
  active,
  children,
}: FieldToolbarButtonProps): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          aria-pressed={active}
          className={cn(
            "size-6 p-0 [&_svg]:size-3.5",
            active
              ? // The darker green keeps the icon legible on a light strip.
                "bg-keeperhub-green/10 text-keeperhub-green-dark hover:bg-keeperhub-green/20 hover:text-keeperhub-green-dark dark:text-keeperhub-green dark:hover:bg-keeperhub-green/20 dark:hover:text-keeperhub-green"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={onClick}
          size="sm"
          type="button"
          variant="ghost"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
