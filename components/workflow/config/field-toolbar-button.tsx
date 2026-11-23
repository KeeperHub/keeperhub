"use client";

import { useImperativeHandle, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** What a caller can do with a toolbar button beyond rendering it. */
export type FieldToolbarButtonHandle = {
  /**
   * Moves focus to the button without showing its tooltip. Radix opens a
   * tooltip on any focus that does not follow a pointer press, so focus put
   * back by code would otherwise leave the tooltip over the field - where it
   * also takes the next Escape before anything under it.
   */
  focusWithoutTooltip: () => void;
};

type FieldToolbarButtonProps = {
  /**
   * Names the action for assistive technology; the button shows only an icon.
   * A toggle keeps one name and lets `pressed` carry its state.
   */
  label: string;
  /** What the button does, shown on hover and focus. */
  tooltip: string;
  onClick: () => void;
  /**
   * Makes the button a toggle, announced as pressed or not. Drawn green while
   * pressed.
   */
  pressed?: boolean;
  /**
   * Draws the button green without making it a toggle - for the action that
   * undoes a state, like leaving full screen.
   */
  highlighted?: boolean;
  handleRef?: React.Ref<FieldToolbarButtonHandle>;
  children: React.ReactNode;
};

/**
 * Icon button for the strip along the top of a config field, beside Beautify.
 *
 * It shares Beautify's states so the strip reads as one control: grey icon at
 * rest, a grey background with a white icon on hover. A button that is on is
 * green, with a stronger green on hover, so the hover highlight never reads as
 * it having switched off.
 */
export function FieldToolbarButton({
  label,
  tooltip,
  onClick,
  pressed,
  highlighted,
  handleRef,
  children,
}: FieldToolbarButtonProps): React.ReactElement {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  // Set only for the duration of a focus() made by focusWithoutTooltip, which
  // is when Radix asks synchronously to open the tooltip.
  const quietFocusRef = useRef(false);

  useImperativeHandle(
    handleRef,
    () => ({
      focusWithoutTooltip: (): void => {
        quietFocusRef.current = true;
        buttonRef.current?.focus();
        quietFocusRef.current = false;
      },
    }),
    []
  );

  const on = pressed === true || highlighted === true;
  return (
    <Tooltip
      onOpenChange={(open) => {
        if (open && quietFocusRef.current) {
          return;
        }
        setTooltipOpen(open);
      }}
      open={tooltipOpen}
    >
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          aria-pressed={pressed}
          className={cn(
            "size-6 p-0 [&_svg]:size-3.5",
            on
              ? // The darker green keeps the icon legible on a light strip.
                "bg-keeperhub-green/10 text-keeperhub-green-dark hover:bg-keeperhub-green/20 hover:text-keeperhub-green-dark dark:text-keeperhub-green dark:hover:bg-keeperhub-green/20 dark:hover:text-keeperhub-green"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={onClick}
          ref={buttonRef}
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

/** The rule between Beautify and the buttons after it. */
export function FieldToolbarDivider(): React.ReactElement {
  return <div aria-hidden="true" className="mx-1 h-3.5 w-px bg-border" />;
}
