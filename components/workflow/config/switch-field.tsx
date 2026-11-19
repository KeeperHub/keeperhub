"use client";

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
  // Shown only so a stray value can be cleared: the switch is locked and
  // Reset is the only action.
  resetOnly?: boolean;
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
  const stray = !isToggleValue(value);
  const locked = stray && resetOnly === true;
  const describedBy = [
    description ? `${id}-description` : "",
    stray ? `${id}-stray` : "",
  ]
    .filter(Boolean)
    .join(" ");
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
            <p className="text-destructive text-xs" id={`${id}-stray`}>
              Holds a template or other value, not on or off. A save refuses a
              new value like this.
              {locked &&
                " This setting is hidden for the current choices, so reset it."}
            </p>
            {!disabled && (
              <Button
                className="h-auto min-h-6 p-0 py-1 text-xs"
                onClick={() => onChange(undefined)}
                type="button"
                variant="link"
              >
                Reset to default<span className="sr-only"> ({label})</span>
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
      />
    </div>
  );
}
