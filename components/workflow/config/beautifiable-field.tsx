"use client";

import { useCallback, useRef } from "react";
import { BeautifyButton } from "@/components/workflow/config/beautify-button";
import { useBeautify } from "@/lib/hooks/use-beautify";
import { cn } from "@/lib/utils";
import {
  canBeautifyLanguage,
  isWithinBeautifySize,
  TOO_LARGE_REASON,
} from "@/lib/utils/beautify";

type BeautifiableFieldProps = {
  /** The field's stored text. Formatting preserves whichever form it is in. */
  value: string;
  onChange: (value: string) => void;
  language: string;
  disabled?: boolean;
  /**
   * Hides the action while keeping the frame, for a field that is present but
   * not currently editable - the ABI field in automatic mode, say.
   */
  showAction?: boolean;
  className?: string;
  children: React.ReactNode;
};

/**
 * The frame every beautifiable config field shares: a border around the input,
 * with the action in a strip along the top.
 *
 * It exists so the three families - the Monaco editors, the JSON textareas and
 * the ABI field - cannot drift apart. They did once: the textareas carried the
 * action on a row of its own between the label and the input, because the
 * badge editor draws its own border and wrapping it looked like more work than
 * it was.
 *
 * The strip is dropped for a language with no formatter behind it, so the
 * frame is still the same element on the SQL field.
 */
export function BeautifiableField({
  value,
  onChange,
  language,
  disabled,
  showAction = true,
  className,
  children,
}: BeautifiableFieldProps): React.ReactElement {
  // A ref, so the hook compares against the field's current text rather than
  // the value captured when the action was clicked.
  const valueRef = useRef(value);
  valueRef.current = value;
  const read = useCallback((): string => valueRef.current, []);

  const { pending, beautify } = useBeautify({
    apply: onChange,
    disabled,
    language,
    read,
  });

  const actionVisible = showAction && canBeautifyLanguage(language);
  // Formatting a field this large would leave the workflow too big for the
  // import route to accept, and nothing in the product puts it back. The
  // control stays visible and says why rather than disappearing.
  const tooLarge = !isWithinBeautifySize(value);

  // The frame owns the border, and with it the two states the border carries:
  // the focus ring and the disabled dimming. Both used to live on the input,
  // which still draws them - a ring is a box-shadow outside the border box, so
  // `overflow-hidden` clipped it away and left the field with no focus
  // indicator at all, and the dimming stopped reaching the border once the
  // border moved out here. The callers cancel the input's own copies.
  //
  // The ring keys off the input specifically rather than `focus-within`: the
  // button is inside the frame too, so tabbing to it would otherwise ring the
  // whole field as though the editor had focus.
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border transition-colors",
        "has-[[data-beautify-input]:focus-within]:ring-1",
        "has-[[data-beautify-input]:focus-within]:ring-ring",
        disabled && "opacity-50",
        className
      )}
    >
      {actionVisible && (
        <div className="flex items-center justify-end border-b bg-muted/30 px-1.5 py-1">
          <BeautifyButton
            disabled={disabled || tooLarge}
            language={language}
            onBeautify={beautify}
            pending={pending}
            reason={tooLarge ? TOO_LARGE_REASON : undefined}
          />
        </div>
      )}
      <div data-beautify-input>{children}</div>
    </div>
  );
}
