"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { isToggleValue } from "@/lib/utils";
import { stripControlChars } from "@/lib/utils/control-chars";
import { canKeepStrayValue } from "@/lib/workflow/validation/stray-toggle-value";
import { readToggle, type ToggleRule } from "@/plugins/registry";

const SHOWN_VALUE_MAX_CHARS = 60;


// What the step does with a value that is neither on nor off.
function strayAtRun(rule: ToggleRule): string {
  return rule === "default-on"
    ? "When the step runs, it is on unless this resolves to false."
    : "When the step runs, it fails unless this resolves to true, false or nothing.";
}

// The stored value as the hint quotes it: visible characters, shortened.
function shownValue(value: unknown): string {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value !== "string") {
    return "a list or object";
  }
  const chars = Array.from(stripControlChars(value));
  const text =
    chars.length > SHOWN_VALUE_MAX_CHARS
      ? `${chars.slice(0, SHOWN_VALUE_MAX_CHARS).join("")}...`
      : chars.join("");
  return `"${text}"`;
}

// Whether a save can keep the value (lib/workflow/validation/stray-toggle-value).
function saveSentence(value: unknown): string {
  return canKeepStrayValue(value)
    ? " A save keeps it only while the saved workflow holds this same value and the steps it reads are not replaced."
    : " A save refuses it, so reset it to save.";
}

type SwitchFieldProps = {
  id: string;
  label: string;
  description?: string;
  // The raw saved value; checked and the stray state both come from it.
  value: unknown;
  // The rule its step reads the value by; the hint is worded from it too.
  rule: ToggleRule;
  // undefined clears the saved value, so the toggle falls back to its default.
  onChange: (value: boolean | undefined) => void;
  disabled?: boolean;
  // Shown only so a stray value can be cleared (isShownOnlyToFix): the switch
  // is locked and Reset is the only action. Required so no caller forgets it.
  resetOnly: boolean;
};

/**
 * Layout for every labelled on/off toggle in a node's config form. Each passes
 * its rule: an absent value reads as on for some toggles and off for others.
 */
export function SwitchField({
  id,
  label,
  description,
  value,
  rule,
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
    // A locked field hides once reset, so focus its group's header instead.
    const header = locked
      ? resetButtonRef.current
          ?.closest<HTMLElement>("[data-field-group]")
          ?.querySelector<HTMLButtonElement>("button")
      : undefined;
    if (header) {
      header.focus();
    } else {
      focusAfterReset.current = true;
    }
    onChange(undefined);
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description && (
          <p className="text-muted-foreground text-xs" id={`${id}-description`}>
            {description}
          </p>
        )}
        {stray && (
          <div className="space-y-1">
            <p className="break-words text-destructive text-xs" id={strayId}>
              Holds {shownValue(value)}, which is neither on nor off.{" "}
              {strayAtRun(rule)}
              {!disabled && saveSentence(value)}
              {locked &&
                !disabled &&
                " Hidden with these settings; reset it here."}
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
                Reset to default ({readToggle(rule, undefined) ? "on" : "off"})
                <span className="sr-only">, {label}</span>
              </Button>
            )}
          </div>
        )}
      </div>
      <Switch
        aria-describedby={describedBy || undefined}
        checked={readToggle(rule, value)}
        disabled={disabled || locked}
        id={id}
        onCheckedChange={onChange}
        ref={switchRef}
      />
    </div>
  );
}
