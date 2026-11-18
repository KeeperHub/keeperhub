"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { stripControlChars } from "@/lib/utils/control-chars";
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

const MAX_KEPT_LENGTH = 1000;
const MAX_SHOWN_LENGTH = 60;
// The start of a JSON or \\uXXXX escape left open by a cut.
const PARTIAL_ESCAPE = /\\(?:u[0-9a-f]{0,3})?$/;

// Cuts by code point, so a cut never splits a character in two.
function cut(text: string, length: number): string {
  return Array.from(text).slice(0, length).join("");
}

// A control or bidi character could reorder or hide what the message shows,
// so each is written out as an escape.
function escapeHidden(char: string): string {
  return `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
}

function describeSaved(saved: unknown): string {
  // An object or array is summed up, not stringified, so a huge one is cheap.
  if (Array.isArray(saved)) {
    return `[${saved.length} items]`;
  }
  if (typeof saved === "object" && saved !== null) {
    return "{…}";
  }
  // A huge string is cut first, so it costs no more than a short one.
  const head =
    typeof saved === "string"
      ? cut(saved.slice(0, MAX_KEPT_LENGTH * 2), MAX_KEPT_LENGTH)
      : saved;
  const text = stripControlChars(JSON.stringify(head) ?? String(head), {
    replacement: escapeHidden,
  });
  const kept = cut(text, MAX_KEPT_LENGTH);
  return kept.length < text.length ? `${kept}…` : kept;
}

// The saved value as the message shows it; the mark sits outside the quotes.
function shortenSaved(text: string): string {
  if (Array.from(text).length <= MAX_SHOWN_LENGTH) {
    return text;
  }
  const shown = cut(text, MAX_SHOWN_LENGTH).replace(PARTIAL_ESCAPE, "");
  return text.startsWith('"') ? `${shown}"…` : `${shown}…`;
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
  if (typeof saved === "string" && isSavableBoolValue(saved)) {
    return { value: saved };
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
          {disabled ? "" : " Select true or false to replace it."}
        </p>
      )}
    </div>
  );
}
