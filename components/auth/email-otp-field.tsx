"use client";

import { useEffect, useRef } from "react";
import { Label } from "@/components/ui/label";

/**
 * Email-OTP input rendered as a <div contentEditable>, NOT an <input>.
 *
 * Why: password manager content scripts (1Password, Bitwarden, LastPass,
 * Dashlane) only target input/textarea/select. Anything that looks like
 * a 6-digit numeric field with `autoComplete="one-time-code"` is a
 * magnet for TOTP-fill heuristics, even with `data-1p-ignore` and
 * similar opt-outs. Replacing the element type entirely puts this field
 * outside the autofill domain, so a stray TOTP fill cannot land here.
 *
 * Behaviour parity with a normal numeric OTP input:
 *   - mobile numeric keyboard (`inputMode="numeric"`)
 *   - sanitises to digits only, max 6
 *   - paste handling: clipboard is sanitised, caret moves to end
 *   - external value changes (e.g. resend clearing the code) sync into
 *     the DOM without disrupting the caret while the user is typing
 *   - onEnter fires when the user hits Enter on a complete code
 */

type Props = {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  onEnter?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  labelClassName?: string;
};

const FIELD_CLASSES =
  "block h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-center shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 font-mono text-lg tracking-[0.3em] [text-indent:-0.3em]";

const PLACEHOLDER_CLASSES =
  "pointer-events-none absolute inset-0 block select-none px-3 py-1 text-center font-mono text-lg text-muted-foreground tracking-[0.3em] [text-indent:-0.3em]";

const DIGIT_ONLY = /\D/g;

function sanitizeOtp(raw: string): string {
  return raw.replace(DIGIT_ONLY, "").slice(0, 6);
}

function placeCaretAtEnd(node: HTMLElement): void {
  if (typeof window === "undefined") {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

export function EmailOtpField({
  id,
  label,
  value,
  onChange,
  onEnter,
  disabled = false,
  autoFocus = false,
  labelClassName,
}: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);

  // Sync external value changes into the DOM, but never while the user
  // is actively typing — overwriting textContent during input would
  // move the caret and feel broken.
  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    if (typeof document !== "undefined" && document.activeElement === node) {
      return;
    }
    if (node.textContent !== value) {
      node.textContent = value;
    }
  }, [value]);

  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus();
    }
  }, [autoFocus]);

  return (
    <div className="space-y-2">
      <Label className={labelClassName} htmlFor={id}>
        {label}
      </Label>
      <div className="relative">
        {value.length === 0 && (
          <div aria-hidden="true" className={PLACEHOLDER_CLASSES}>
            000000
          </div>
        )}
        {/* biome-ignore lint/a11y/useSemanticElements: input-equivalent semantics intentionally avoided so password managers cannot fill this field */}
        <div
          aria-label={label}
          aria-required="true"
          className={`${FIELD_CLASSES} ${
            disabled
              ? "pointer-events-none cursor-not-allowed opacity-50"
              : "cursor-text"
          }`}
          contentEditable={!disabled}
          id={id}
          inputMode="numeric"
          onInput={(event) => {
            const node = event.currentTarget;
            const next = sanitizeOtp(node.textContent ?? "");
            if (node.textContent !== next) {
              node.textContent = next;
              placeCaretAtEnd(node);
            }
            if (next !== value) {
              onChange(next);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (!disabled && value.length === 6) {
                onEnter?.();
              }
            }
          }}
          onPaste={(event) => {
            event.preventDefault();
            const pasted = event.clipboardData.getData("text");
            const sanitized = sanitizeOtp(pasted);
            const node = event.currentTarget;
            node.textContent = sanitized;
            placeCaretAtEnd(node);
            onChange(sanitized);
          }}
          ref={ref}
          role="textbox"
          spellCheck={false}
          suppressContentEditableWarning
          tabIndex={disabled ? -1 : 0}
        />
      </div>
    </div>
  );
}
