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
  unrecognized?: UnrecognizedValue;
  onChange: (value: unknown) => void;
  disabled?: boolean;
};

// A saved value that is not a bool, shown so it is not mistaken for unset:
// shortened for the message, longer for its tooltip.
type UnrecognizedValue = { shown: string; full: string };

type ProtocolBoolFieldValue = {
  value: string;
  unrecognized?: UnrecognizedValue;
};

const MAX_KEPT_LENGTH = 1000;
const MAX_SHOWN_LENGTH = 60;

// A control or bidi character could reorder or hide what the message shows,
// so each is written out as an escape.
function escapeHidden(char: string): string {
  const code = (char.codePointAt(0) ?? 0).toString(16);
  return code.length > 4 ? `\\u{${code}}` : `\\u${code.padStart(4, "0")}`;
}

function quote(text: string): string {
  return stripControlChars(JSON.stringify(text), { replacement: escapeHidden });
}

// The raw string is cut by code point before it is quoted, so a cut never
// splits a character or an escape. The mark sits outside the quotes.
function shorten(text: string, length: number): string {
  const head = Array.from(text.slice(0, length * 2 + 2));
  return head.length <= length
    ? quote(text)
    : `${quote(head.slice(0, length).join(""))}…`;
}

function summarise(saved: object): string {
  // Summed up, not stringified, so a huge one is cheap.
  if (Array.isArray(saved)) {
    if (saved.length === 0) {
      return "[]";
    }
    return saved.length === 1 ? "[1 item]" : `[${saved.length} items]`;
  }
  return Object.keys(saved).length === 0 ? "{}" : "{…}";
}

function describeSaved(saved: unknown): UnrecognizedValue {
  if (typeof saved === "string") {
    return {
      shown: shorten(saved, MAX_SHOWN_LENGTH),
      full: shorten(saved, MAX_KEPT_LENGTH),
    };
  }
  const text =
    typeof saved === "object" && saved !== null
      ? summarise(saved)
      : String(saved);
  return { shown: text, full: text };
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
            title={
              unrecognized.shown === unrecognized.full
                ? undefined
                : unrecognized.full
            }
          >
            {unrecognized.shown}
          </bdi>{" "}
          is not true or false.
          {disabled ? "" : " Select one to replace it."}
        </p>
      )}
    </div>
  );
}
