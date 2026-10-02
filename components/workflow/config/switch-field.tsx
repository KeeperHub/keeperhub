"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type SwitchFieldProps = {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
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
}: SwitchFieldProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description && (
          <p className="text-muted-foreground text-xs">{description}</p>
        )}
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        id={id}
        onCheckedChange={onChange}
      />
    </div>
  );
}
