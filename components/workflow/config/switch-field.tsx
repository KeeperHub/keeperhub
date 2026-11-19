"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { isToggleValue } from "@/lib/utils";

type SwitchFieldProps = {
  id: string;
  label: string;
  description?: string;
  // The raw saved value; checked and the stray state both come from it.
  value: unknown;
  // The toggle's own rule for what a value means, the one its step applies.
  isOn: (value: unknown) => boolean;
  // undefined clears the saved value, so the toggle falls back to its default.
  onChange: (value: boolean | undefined) => void;
  disabled?: boolean;
  // Shown only so a stray value can be cleared (isShownOnlyToFix): the switch
  // is locked and Reset is the only action. Required so no caller forgets it.
  resetOnly: boolean;
};

/**
 * Layout for every labelled on/off toggle in a node's config form. Each
 * toggle passes its own `isOn`: the ones that default on cannot be told apart
 * from the ones that default off by looking at an absent stored value.
 */
export function SwitchField({
  id,
  label,
  description,
  value,
  isOn,
  onChange,
  disabled,
  resetOnly,
}: SwitchFieldProps) {
  const switchRef = useRef<HTMLButtonElement>(null);
  const resetButtonRef = useRef<HTMLButtonElement>(null);
  const focusAfterReset = useRef(false);
  const stray = !isToggleValue(value);
  const locked = stray && resetOnly;
  const strayId = `${id}-stray`;
  const describedBy = [
    description ? `${id}-description` : "",
    stray ? strayId : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Reset removes its own button, so keep keyboard focus on the switch.
  useEffect(() => {
    if (focusAfterReset.current && !stray) {
      focusAfterReset.current = false;
      switchRef.current?.focus();
    }
  }, [stray]);

  const reset = () => {
    if (locked) {
      // The whole field hides once reset, so focus its group's header.
      resetButtonRef.current
        ?.closest<HTMLElement>("[data-field-group]")
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus();
    } else {
      focusAfterReset.current = true;
    }
    onChange(undefined);
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description && (
          <p className="text-muted-foreground text-xs" id={`${id}-description`}>
            {description}
          </p>
        )}
        {stray && (
          <div className="space-y-1">
            <p className="text-destructive text-xs" id={strayId}>
              Holds a template or other value, not on or off. It runs as saved,
              but a save refuses a new value like this.
              {locked &&
                !disabled &&
                " It is normally hidden with these settings, so it can only be reset here."}
            </p>
            {!disabled && (
              <Button
                aria-describedby={strayId}
                className="h-auto min-h-6 p-0 py-1 text-xs"
                onClick={reset}
                ref={resetButtonRef}
                type="button"
                variant="link"
              >
                Reset to default ({isOn(undefined) ? "on" : "off"})
                <span className="sr-only">, {label}</span>
              </Button>
            )}
          </div>
        )}
      </div>
      <Switch
        aria-describedby={describedBy || undefined}
        checked={isOn(value)}
        disabled={disabled || locked}
        id={id}
        onCheckedChange={onChange}
        ref={switchRef}
      />
    </div>
  );
}
