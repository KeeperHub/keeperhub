"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import { escapeHiddenChars } from "@/lib/utils/control-chars";
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

const MAX_SHOWN_LENGTH = 60;

// Quoted one character at a time, each escaped (a control or bidi character
// could reorder or hide the message), stopping before the shown text passes
// MAX_SHOWN_LENGTH. So a cut never splits an escape, and a value of hidden
// characters cannot grow past the limit. The mark sits outside the quotes.
function quoteShortened(text: string): string {
  let shown = "";
  let size = 0;
  for (const char of text) {
    const piece = escapeHiddenChars(JSON.stringify(char).slice(1, -1));
    // Counted in characters: an emoji is one, an escape is its length.
    const pieceSize = Array.from(piece).length;
    if (size + pieceSize > MAX_SHOWN_LENGTH) {
      return `"${shown}"…`;
    }
    shown += piece;
    size += pieceSize;
  }
  return `"${shown}"`;
}

// Summed up in words, not stringified: cheap for a huge one, and read aloud.
function summarise(saved: object): string {
  if (Array.isArray(saved)) {
    if (saved.length === 0) {
      return "(empty list)";
    }
    return saved.length === 1
      ? "(list of 1 item)"
      : `(list of ${saved.length} items)`;
  }
  return Object.keys(saved).length === 0 ? "(empty object)" : "(object)";
}

function describeSaved(saved: unknown): string {
  if (typeof saved === "string") {
    return quoteShortened(saved);
  }
  return typeof saved === "object" && saved !== null
    ? summarise(saved)
    : String(saved);
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
          <bdi className="wrap-anywhere whitespace-pre-wrap font-mono">
            {unrecognized}
          </bdi>{" "}
          is not true or false.
          {disabled ? "" : " Select one to replace it."}
        </p>
      )}
    </div>
  );
}
