"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { resolveFailOnError } from "@/lib/utils";

type FailOnErrorSwitchFieldProps = {
  id: string;
  label: string;
  description?: string;
  value: unknown;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
};

/**
 * Shared "Fail workflow on error" toggle, used by both the HTTP Request
 * node (hardcoded system action) and the Write Contract node (declarative
 * plugin "fail-on-error-switch" field) so the layout and default-on resolution logic
 * (resolveFailOnError) live in exactly one place.
 */
export function FailOnErrorSwitchField({
  id,
  label,
  description,
  value,
  onChange,
  disabled,
}: FailOnErrorSwitchFieldProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description && (
          <p className="text-muted-foreground text-xs">{description}</p>
        )}
      </div>
      <Switch
        checked={resolveFailOnError(value)}
        disabled={disabled}
        id={id}
        onCheckedChange={onChange}
      />
    </div>
  );
}
