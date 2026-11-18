"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { isSavableBoolValue } from "@/lib/workflow/validation/action-config";
import { hasTemplateToken } from "@/lib/workflow/template-ref";

type ProtocolBoolFieldProps = {
  fieldKey: string;
  value: string;
  unrecognized?: string;
  onChange: (value: unknown) => void;
  disabled?: boolean;
};

type ProtocolBoolFieldValue = {
  value: string;
  // A saved value that is not a bool, shown so it is not mistaken for unset.
  unrecognized?: string;
};

// Control and invisible format characters (bidi overrides, zero-width) could
// reorder or hide what the message shows, so they are written out as escapes.
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/gu;
const MAX_KEPT_LENGTH = 1000;
const MAX_SHOWN_LENGTH = 60;

// Cuts by code point, so a cut never splits a character in two.
function cut(text: string, length: number): string {
  return Array.from(text).slice(0, length).join("");
}

function describeSaved(saved: unknown): string {
  // Cut first, so a huge saved value costs no more than a short one.
  // 2 UTF-16 units per code point at most, so the slice keeps enough.
  const head =
    typeof saved === "string"
      ? cut(saved.slice(0, MAX_KEPT_LENGTH * 2), MAX_KEPT_LENGTH)
      : saved;
  const text = cut(JSON.stringify(head) ?? String(head), MAX_KEPT_LENGTH);
  return text.replace(
    HIDDEN_CHARACTER,
    (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`
  );
}

// The saved value as the message shows it; a cut string keeps its quotes.
function shortenSaved(text: string): string {
  if (Array.from(text).length <= MAX_SHOWN_LENGTH) {
    return text;
  }
  const shown = `${cut(text, MAX_SHOWN_LENGTH)}...`;
  return text.startsWith('"') ? `${shown}"` : shown;
}

// A saved JSON true/false (agents may send one) shows as the matching option.
export function protocolBoolFieldValue(
  saved: unknown,
  defaultValue: string | undefined
): ProtocolBoolFieldValue {
  if (saved === undefined || saved === "") {
    return { value: defaultValue || "" };
  }
  if (typeof saved === "boolean") {
    return { value: String(saved) };
  }
  if (isSavableBoolValue(saved)) {
    return { value: saved as string };
  }
  return { value: "", unrecognized: describeSaved(saved) };
}

export function ProtocolBoolField({
  fieldKey,
  value,
  unrecognized,
  onChange,
  disabled,
}: ProtocolBoolFieldProps): React.ReactNode {
  const isTemplateValue = hasTemplateToken(value ?? "");

  if (isTemplateValue) {
    return (
      <TemplateBadgeInput
        disabled={disabled}
        id={fieldKey}
        onChange={onChange}
        placeholder="true or false"
        value={value ?? ""}
      />
    );
  }

  const errorId = `${fieldKey}-unrecognized`;
  const shown = unrecognized ? shortenSaved(unrecognized) : "";
  return (
    <div>
      <Select
        disabled={disabled}
        onValueChange={(val: string) => onChange(val)}
        value={value || ""}
      >
        <SelectTrigger
          aria-describedby={unrecognized ? errorId : undefined}
          aria-invalid={unrecognized ? true : undefined}
          id={fieldKey}
        >
          <SelectValue placeholder="Select true or false" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">true</SelectItem>
          <SelectItem value="false">false</SelectItem>
        </SelectContent>
      </Select>
      {unrecognized && (
        <p className="mt-1 text-xs text-destructive" id={errorId}>
          Saved value{" "}
          <bdi
            className="wrap-anywhere whitespace-pre-wrap font-mono"
            title={shown === unrecognized ? undefined : unrecognized}
          >
            {shown}
          </bdi>{" "}
          is not true or false.
          {disabled ? "" : " Choose true or false to replace it."}
        </p>
      )}
    </div>
  );
}
