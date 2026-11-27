"use client";

import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { readNameList } from "@/lib/web3/bundles/settings";

type MultiSelectChoice = { value: string; label: string };

type MultiSelectPickerProps = {
  label: string;
  value: unknown;
  /** The choices; undefined while they are not known (they are checked later). */
  choices: readonly MultiSelectChoice[] | undefined;
  /** What the choices are, plural ("builders"). */
  noun: string;
  /** The "all" row: stores nothing, so later choices are included too. */
  allLabel: string;
  allHint: string;
  /** Why a stored value is not among the choices, shown beside it. */
  missingNote: (names: string[]) => string;
  /** Shown after a stored value the choices do not list. */
  missingSuffix: string;
  unknownNote: string;
  max?: number;
  disabled?: boolean;
  /** Prefix of the list's and the unchecked note's test ids. */
  testId?: string;
  onChange: (value: string[] | undefined) => void;
};

/**
 * A multi-select picker: all by default (nothing stored), or a list of picked
 * values, at least one. The bundle box's Builders field.
 */
export function MultiSelectPicker({
  label,
  value,
  choices,
  allLabel,
  allHint,
  missingNote,
  missingSuffix,
  unknownNote,
  noun,
  max,
  disabled,
  testId = "multi-select",
  onChange,
}: MultiSelectPickerProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const listId = useId();
  const lastId = useId();
  const allHintId = useId();
  // A malformed list shows as all; the save says what is wrong with it.
  const picked = readNameList(value, max) ?? undefined;
  const all = picked === undefined;
  const known = choices ?? [];
  const knownValues = known.map((choice) => choice.value);
  // Names saved earlier the choices do not list; only when the choices are known.
  const missing =
    choices === undefined
      ? []
      : (picked ?? []).filter((name) => !knownValues.includes(name));
  const unlisted = choices === undefined ? (picked ?? []) : missing;
  const rows: MultiSelectChoice[] = [
    ...known,
    ...unlisted.map((name) => ({ value: name, label: name })),
  ];
  const checked = (name: string): boolean => all || picked.includes(name);
  const checkedCount = rows.filter((row) => checked(row.value)).length;

  let summary = allLabel;
  if (all && known.length > 0) {
    summary = `All ${known.length} ${noun}, including new ones`;
  } else if (!all) {
    summary =
      known.length > 0
        ? `${picked.length} of ${known.length} ${noun}, not new ones`
        : `${picked.length} ${noun} picked`;
  }

  const toggle = (name: string, on: boolean): void => {
    const current = all ? [...knownValues] : [...picked];
    const next = on
      ? [...current, name]
      : current.filter((entry) => entry !== name);
    // Keep the choices' order, then any values they do not list.
    onChange(rows.map((row) => row.value).filter((row) => next.includes(row)));
  };

  return (
    <div className="space-y-2">
      <Label className="ml-1" htmlFor={id}>
        {label}
      </Label>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            aria-controls={open ? listId : undefined}
            aria-expanded={open}
            className="h-auto min-h-9 w-full justify-between whitespace-normal px-3 py-2 text-left font-normal"
            disabled={disabled || rows.length === 0}
            id={id}
            type="button"
            variant="outline"
          >
            {/* Wraps in a narrow panel: "including new ones" is the point of the line. */}
            <span className="min-w-0 break-words">{summary}</span>
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 opacity-50"
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-(--radix-popover-trigger-width) min-w-56 p-1"
          data-testid={`${testId}-list`}
          id={listId}
        >
          <fieldset className="space-y-0.5">
            <legend className="sr-only">{label}</legend>
            <PickerRow
              checked={all}
              describedBy={allHintId}
              disabled={disabled || choices === undefined}
              label={allLabel}
              onChange={(on) => onChange(on ? undefined : [...knownValues])}
            />
            <p
              className="px-2 pb-1 text-muted-foreground text-xs"
              id={allHintId}
            >
              {allHint}
            </p>
            <div className="my-1 border-t" />
            {rows.map((row) => {
              const isChecked = checked(row.value);
              const onlyOne = isChecked && checkedCount === 1;
              return (
                <PickerRow
                  checked={isChecked}
                  describedBy={onlyOne ? lastId : undefined}
                  disabled={disabled}
                  key={row.value}
                  label={
                    missing.includes(row.value)
                      ? `${row.label} (${missingSuffix})`
                      : row.label
                  }
                  locked={onlyOne}
                  onChange={(on) => toggle(row.value, on)}
                />
              );
            })}
          </fieldset>
          {checkedCount === 1 && (
            <p
              aria-live="polite"
              className="px-2 py-1 text-muted-foreground text-xs"
              id={lastId}
            >
              At least one of the {noun} is needed.
            </p>
          )}
        </PopoverContent>
      </Popover>
      {missing.length > 0 && (
        <p className="ml-1 text-destructive text-xs">{missingNote(missing)}</p>
      )}
      {choices === undefined && !all && (
        <p
          className="ml-1 text-muted-foreground text-xs"
          data-testid={`${testId}-unchecked`}
        >
          {unknownNote}
        </p>
      )}
    </div>
  );
}

function PickerRow({
  checked,
  disabled,
  locked,
  label,
  describedBy,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  // Stays focusable and announced, but cannot be unticked.
  locked?: boolean;
  label: string;
  describedBy?: string;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div
      className={cn(
        "flex min-h-8 touch-ui:min-h-11 items-center gap-2 rounded-sm px-2 hover:bg-accent",
        (disabled || locked) && "hover:bg-transparent"
      )}
    >
      <Checkbox
        aria-describedby={describedBy}
        aria-disabled={locked || undefined}
        checked={checked}
        disabled={disabled}
        id={id}
        onCheckedChange={(next) => {
          if (!locked) {
            onChange(next === true);
          }
        }}
      />
      <Label
        className="min-w-0 flex-1 cursor-pointer break-words py-1 font-normal"
        htmlFor={id}
      >
        {label}
      </Label>
    </div>
  );
}
