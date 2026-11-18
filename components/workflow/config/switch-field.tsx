"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { isToggleValue } from "@/lib/utils";

type SwitchFieldProps = {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  // The raw saved value, only to flag one that is neither on nor off.
  storedValue?: unknown;
};

/**
 * Layout for every labelled on/off toggle in a node's config form. It takes a
 * resolved `checked` rather than a raw config value on purpose: each toggle
 * decides its own default (see resolveFailOnError, resolveSponsorGas), and
 * the ones that default on cannot be told apart from the ones that default
 * off by looking at an absent stored value.
 */
export function SwitchField({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
  storedValue,
}: SwitchFieldProps) {
  const stray = !isToggleValue(storedValue);
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
          <p className="text-destructive text-xs" id={`${id}-stray`}>
            This was saved as something other than on or off. Turn it off and
            on to fix it.
          </p>
        )}
      </div>
      <Switch
        aria-describedby={describedBy || undefined}
        checked={checked}
        disabled={disabled}
        id={id}
        onCheckedChange={onChange}
      />
    </div>
  );
}
