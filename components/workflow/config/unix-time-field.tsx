"use client";

import { type ReactNode, useId } from "react";
import { Label } from "@/components/ui/label";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { cn } from "@/lib/utils";
import { readUnixTime } from "@/lib/web3/unix-time";
import {
  formatDateTime,
  formatDateTimeWithZone,
} from "@/lib/web3/unix-time-display";

const TEMPLATE_MARK = "{{";

export type UnixTimeCheck =
  | { kind: "empty" }
  | { kind: "template" }
  | { kind: "time"; seconds: number }
  | { kind: "error"; reason: string };

/** A typed time as a save reads it: empty, a template (read at run time), a time, or why not. */
export function checkUnixTime(value: unknown): UnixTimeCheck {
  const text =
    typeof value === "string" ? value.trim() : String(value ?? "").trim();
  if (text === "") {
    return { kind: "empty" };
  }
  if (text.includes(TEMPLATE_MARK)) {
    return { kind: "template" };
  }
  const read = readUnixTime(text, { strict: true });
  return read.ok
    ? { kind: "time", seconds: read.seconds }
    : { kind: "error", reason: read.reason };
}

type UnixTimeFieldProps = {
  /** Also the input's id, so a save error can focus it by its config key. */
  fieldKey: string;
  label: string;
  value: unknown;
  placeholder?: string;
  hints: readonly ReactNode[];
  /** Shown as an error while the field is empty; none means empty is fine. */
  emptyError?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
};

/** A time in unix seconds or a date with a zone, with what it reads as or why it is refused. */
export function UnixTimeField({
  fieldKey,
  label,
  value,
  placeholder,
  hints,
  emptyError,
  disabled,
  onChange,
}: UnixTimeFieldProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const messageId = `${id}-message`;
  const hintIds = hints.map((_, index) => `${id}-hint-${index}`);
  const check = checkUnixTime(value);
  let error: string | undefined;
  if (check.kind === "error") {
    error = check.reason;
  } else if (check.kind === "empty") {
    error = emptyError;
  }
  const readsAs = check.kind === "time" ? check.seconds : undefined;
  const describedBy = [
    error !== undefined || readsAs !== undefined ? messageId : undefined,
    ...hintIds,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-2" data-testid={`time-field-${fieldKey}`}>
      <Label className="ml-1" htmlFor={fieldKey} id={labelId}>
        {label}
      </Label>
      <TemplateBadgeInput
        ariaDescribedBy={describedBy || undefined}
        ariaInvalid={error !== undefined}
        ariaLabelledBy={labelId}
        className={cn(error !== undefined && "border-destructive")}
        disabled={disabled}
        id={fieldKey}
        onChange={onChange}
        placeholder={placeholder}
        value={typeof value === "string" ? value : String(value ?? "")}
      />
      {error !== undefined && (
        <p
          className="ml-1 text-destructive text-xs"
          data-testid={`time-field-${fieldKey}-error`}
          id={messageId}
        >
          {error}
        </p>
      )}
      {readsAs !== undefined && (
        <p
          className="ml-1 text-foreground text-xs"
          data-testid={`time-field-${fieldKey}-reads-as`}
          id={messageId}
          title={formatDateTimeWithZone(readsAs)}
        >
          Reads as {formatDateTime(readsAs)} in your time zone ({readsAs}).
        </p>
      )}
      {hints.map((hint, index) => (
        <p
          className="ml-1 text-muted-foreground text-xs"
          id={hintIds[index]}
          key={hintIds[index]}
        >
          {hint}
        </p>
      ))}
    </div>
  );
}
