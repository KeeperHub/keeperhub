"use client";

import { Pencil, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useIsMobile } from "@/hooks/use-mobile";

/** Stand-in for a stored credential. The value itself never reaches the client. */
const MASKED_VALUE = "••••••••••••";

export type SecretFieldProps = {
  fieldId: string;
  label: string;
  configKey: string;
  placeholder?: string;
  helpText?: string;
  helpNode?: React.ReactNode;
  value: string;
  onChange: (key: string, value: string) => void;
  isEditMode?: boolean;
};

/**
 * Password input for a credential the server holds. In edit mode it shows a
 * mask until the user chooses to replace the value; leaving it untouched keeps
 * whatever is stored.
 */
export function SecretField({
  fieldId,
  label,
  configKey,
  placeholder,
  helpText,
  helpNode,
  value,
  onChange,
  isEditMode,
}: SecretFieldProps): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  const isMobile = useIsMobile();
  const hasNewValue = value.length > 0;

  if (isEditMode && !(isEditing || hasNewValue)) {
    return (
      <div className="space-y-2">
        <Label htmlFor={fieldId}>{label}</Label>
        <div className="flex items-center gap-2">
          <div className="flex h-9 flex-1 items-center rounded-md border bg-muted/30 px-3">
            <span className="font-mono text-muted-foreground text-sm tracking-widest">
              {MASKED_VALUE}
            </span>
          </div>
          <Button
            onClick={() => setIsEditing(true)}
            type="button"
            variant="outline"
          >
            <Pencil className="mr-1.5 size-3" />
            Change
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Stored securely. Choose Change to replace it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={fieldId}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          autoFocus={isEditMode && isEditing && !isMobile}
          className="flex-1"
          id={fieldId}
          onChange={(e) => onChange(configKey, e.target.value)}
          placeholder={placeholder}
          type="password"
          value={value}
        />
        {isEditMode && (isEditing || hasNewValue) && (
          <Button
            onClick={() => {
              onChange(configKey, "");
              setIsEditing(false);
            }}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
      {helpNode ??
        (helpText ? (
          <p className="text-muted-foreground text-xs">{helpText}</p>
        ) : null)}
    </div>
  );
}
