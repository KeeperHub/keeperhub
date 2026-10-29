"use client";

import { type ReactNode, useId } from "react";
import { cn } from "@/lib/utils";

export type ChoiceChip<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
  /** A second line; such chips align left. */
  description?: string;
};

/** Radio buttons drawn as a row of chips; the same on every Alerts form. */
export function ChoiceChips<T extends string>({
  legend,
  hideLegend = false,
  options,
  value,
  onChange,
  className,
  testId,
}: {
  legend: string;
  hideLegend?: boolean;
  options: readonly ChoiceChip<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Grid columns for the chips. */
  className?: string;
  testId?: string;
}): React.ReactElement {
  const idPrefix = useId();
  return (
    <fieldset className="min-w-0" data-testid={testId}>
      <legend
        className={cn("mb-1.5 font-medium text-xs", hideLegend && "sr-only")}
      >
        {legend}
      </legend>
      <div className={cn("grid grid-cols-2 gap-2", className)}>
        {options.map((option) => {
          const id = `${idPrefix}-${option.value}`;
          return (
            <label
              className={cn(
                "flex min-h-11 min-w-0 cursor-pointer rounded-md border px-2 py-2 text-xs transition-colors hover:bg-muted/50 @xl/settings:min-h-9",
                option.description
                  ? "flex-col items-start justify-center gap-0.5 px-3 text-left"
                  : "items-center justify-center gap-2 text-center",
                "has-[:checked]:border-foreground/60 has-[:checked]:bg-muted",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50"
              )}
              htmlFor={id}
              key={option.value}
            >
              <input
                checked={value === option.value}
                className="sr-only"
                id={id}
                name={`${idPrefix}-choice`}
                onChange={() => onChange(option.value)}
                type="radio"
                value={option.value}
              />
              {option.description ? (
                <>
                  <span className="font-medium text-sm">{option.label}</span>
                  <span className="text-muted-foreground">
                    {option.description}
                  </span>
                </>
              ) : (
                <>
                  {option.icon}
                  <span className="min-w-0 break-words">{option.label}</span>
                </>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
