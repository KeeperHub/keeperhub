"use client";

import { FoldVertical, Maximize2, UnfoldVertical } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { BeautifyButton } from "@/components/workflow/config/beautify-button";
import { FieldFullScreenDialog } from "@/components/workflow/config/field-full-screen-dialog";
import { FieldToolbarButton } from "@/components/workflow/config/field-toolbar-button";
import { useBeautify } from "@/lib/hooks/use-beautify";
import { cn } from "@/lib/utils";
import {
  canBeautifyLanguage,
  isWithinBeautifySize,
  TOO_LARGE_REASON,
} from "@/lib/utils/beautify";

/**
 * How much room the field's input is given.
 *
 * - `normal`: the size the field asked for.
 * - `tall`: grows to fit its content, up to {@link TALL_FIELD_MAX_LINES}
 *   lines, never shorter than `normal`. Width does not change.
 * - `fill`: fills the full-screen dialog.
 */
export type FieldSize = "normal" | "tall" | "fill";

/** The ceiling on a field made taller, in lines of its own text. */
export const TALL_FIELD_MAX_LINES = 24;

/**
 * The height of a field made taller, in px: its content's height, capped at
 * `maxHeight` and never below the height it has at `normal`.
 */
export function tallFieldHeight({
  normalHeight,
  contentHeight,
  maxHeight,
}: {
  normalHeight: number;
  contentHeight: number;
  maxHeight: number;
}): number {
  return Math.max(normalHeight, Math.min(contentHeight, maxHeight));
}

type BeautifiableFieldProps = {
  /** The field's stored text. Formatting preserves whichever form it is in. */
  value: string;
  onChange: (value: string) => void;
  language: string;
  disabled?: boolean;
  /**
   * Hides the beautify action while keeping the frame, for a field that is
   * present but not currently editable - the ABI field in automatic mode, say.
   * The expand buttons stay: reading a long value is the point of them.
   */
  showAction?: boolean;
  /** Names the field in the full-screen dialog. */
  label?: string;
  className?: string;
  /**
   * The input. Given as a function of {@link FieldSize}, the frame can make it
   * taller and open it in full screen; given as a node, it is only framed.
   */
  children: React.ReactNode | ((size: FieldSize) => React.ReactNode);
};

/**
 * The frame every beautifiable config field shares: a border around the input,
 * with the field's actions in a strip along the top - Beautify, then the two
 * buttons that give the input more room.
 *
 * It exists so the three families - the Monaco editors, the JSON textareas and
 * the ABI field - cannot drift apart. They did once: the textareas carried the
 * action on a row of its own between the label and the input, because the
 * badge editor draws its own border and wrapping it looked like more work than
 * it was.
 *
 * Beautify is dropped for a language with no formatter behind it, so the SQL
 * field keeps the strip for its expand buttons alone.
 */
export function BeautifiableField({
  value,
  onChange,
  language,
  disabled,
  showAction = true,
  label,
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

  const [tall, setTall] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);

  const beautifyVisible = showAction && canBeautifyLanguage(language);
  // Only an input the frame can size gets the buttons that size it.
  const expandable = typeof children === "function";
  // Formatting a field this large would leave the workflow too big for the
  // import route to accept, and nothing in the product puts it back. The
  // control stays visible and says why rather than disappearing.
  const tooLarge = !isWithinBeautifySize(value);

  const renderInput = (size: FieldSize): React.ReactNode =>
    typeof children === "function" ? children(size) : children;

  const beautifyButton = beautifyVisible ? (
    <BeautifyButton
      disabled={disabled || tooLarge}
      language={language}
      onBeautify={beautify}
      pending={pending}
      reason={tooLarge ? TOO_LARGE_REASON : undefined}
    />
  ) : null;

  // The frame owns the border, and with it the two states the border carries:
  // the focus ring and the disabled dimming. Both used to live on the input,
  // which still draws them - a ring is a box-shadow outside the border box, so
  // `overflow-hidden` clipped it away and left the field with no focus
  // indicator at all. The callers cancel the input's own copies.
  //
  // Disabled dims the border and the input but not the strip: Beautify greys
  // itself out, and the expand buttons stay usable on a read-only field.
  //
  // The ring keys off the input specifically rather than `focus-within`: the
  // buttons are inside the frame too, so tabbing to one would otherwise ring
  // the whole field as though the editor had focus.
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border transition-colors",
        "has-[[data-beautify-input]:focus-within]:ring-1",
        "has-[[data-beautify-input]:focus-within]:ring-ring",
        disabled && "border-border/50",
        className
      )}
    >
      {(beautifyVisible || expandable) && (
        <div className="flex items-center justify-end gap-0.5 border-b bg-muted/30 px-1.5 py-1">
          {beautifyButton}
          {beautifyVisible && expandable && (
            <div aria-hidden="true" className="mx-1 h-3.5 w-px bg-border" />
          )}
          {expandable && (
            <>
              <FieldToolbarButton
                active={tall}
                label={tall ? "Back to normal height" : "Make taller"}
                onClick={() => setTall((current) => !current)}
                tooltip={
                  tall
                    ? "Back to normal height"
                    : `Make taller · fits up to ${TALL_FIELD_MAX_LINES} lines`
                }
              >
                {tall ? <FoldVertical /> : <UnfoldVertical />}
              </FieldToolbarButton>
              <FieldToolbarButton
                label="Open in full screen"
                onClick={() => setFullScreen(true)}
                tooltip="Open in full screen"
              >
                <Maximize2 />
              </FieldToolbarButton>
            </>
          )}
        </div>
      )}
      <div className={cn(disabled && "opacity-50")} data-beautify-input>
        {fullScreen ? (
          // One editor at a time: the field stays where it was, holding its
          // place, while the dialog has the only live copy of the input.
          <div className="flex h-24 items-center justify-center text-muted-foreground text-xs">
            Editing in full screen
          </div>
        ) : (
          renderInput(tall ? "tall" : "normal")
        )}
      </div>
      {expandable && (
        <FieldFullScreenDialog
          beautifyButton={beautifyButton}
          label={label}
          onOpenChange={setFullScreen}
          open={fullScreen}
        >
          {renderInput("fill")}
        </FieldFullScreenDialog>
      )}
    </div>
  );
}
