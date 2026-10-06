"use client";

import { FoldVertical, Maximize2, UnfoldVertical } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { BeautifyButton } from "@/components/workflow/config/beautify-button";
import { FieldFullScreenDialog } from "@/components/workflow/config/field-full-screen-dialog";
import {
  FieldToolbarButton,
  type FieldToolbarButtonHandle,
  FieldToolbarDivider,
} from "@/components/workflow/config/field-toolbar-button";
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
 * - `tall`: grows to fit its content, up to a ceiling well above its normal
 *   one, never shorter than `normal`. Width does not change.
 * - `fill`: fills the full-screen dialog.
 */
export type FieldSize = "normal" | "tall" | "fill";

/**
 * The ceiling on a code editor made taller, in lines of its own text. Its
 * normal heights show 5 to 16 lines.
 */
export const TALL_FIELD_MAX_LINES = 24;

/**
 * The ceiling on a text box made taller, in the rows its `maxRows` counts.
 * A JSON text box already grows to 16 rows on its own, so its taller ceiling
 * is double that rather than a few lines more.
 */
export const TALL_FIELD_MAX_ROWS = 32;

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
  /** The input, rendered at the size the frame gives it. */
  children: (size: FieldSize) => React.ReactNode;
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
 *
 * The input is passed as a function of its size so the frame can give it more
 * room; each editor family decides what each size means for it.
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
  // The field's height when full screen opened, so its placeholder holds the
  // same space and the panel does not jump when the dialog closes.
  const [placeholderHeight, setPlaceholderHeight] = useState(0);
  const inputRef = useRef<HTMLDivElement>(null);
  const fullScreenButtonRef = useRef<FieldToolbarButtonHandle>(null);

  const openFullScreen = (): void => {
    setPlaceholderHeight(inputRef.current?.offsetHeight ?? 0);
    setFullScreen(true);
  };

  const beautifyVisible = showAction && canBeautifyLanguage(language);
  // Formatting a field this large would leave the workflow too big for the
  // import route to accept, and nothing in the product puts it back. The
  // control stays visible and says why rather than disappearing.
  const tooLarge = !isWithinBeautifySize(value);

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
      <div className="flex items-center justify-end gap-0.5 border-b bg-muted/30 px-1.5 py-1">
        {beautifyButton}
        {beautifyVisible && <FieldToolbarDivider />}
        <FieldToolbarButton
          label="Make taller"
          onClick={() => setTall((current) => !current)}
          pressed={tall}
          tooltip={
            tall ? "Back to normal height" : "Make taller · grows to fit"
          }
        >
          {tall ? <FoldVertical /> : <UnfoldVertical />}
        </FieldToolbarButton>
        <FieldToolbarButton
          handleRef={fullScreenButtonRef}
          label="Open in full screen"
          onClick={openFullScreen}
          tooltip="Open in full screen"
        >
          <Maximize2 />
        </FieldToolbarButton>
      </div>
      <div
        className={cn(disabled && "opacity-50")}
        data-beautify-input
        ref={inputRef}
      >
        {fullScreen ? (
          // One editor at a time: the field stays where it was, holding its
          // place, while the dialog has the only live copy of the input.
          <div
            className={cn(
              "flex items-center justify-center text-muted-foreground text-xs",
              placeholderHeight === 0 && "h-24"
            )}
            style={{ height: placeholderHeight || undefined }}
          >
            Editing in full screen
          </div>
        ) : (
          children(tall ? "tall" : "normal")
        )}
      </div>
      <FieldFullScreenDialog
        beautifyButton={beautifyButton}
        disabled={disabled}
        label={label}
        onOpenChange={setFullScreen}
        open={fullScreen}
        returnFocusRef={fullScreenButtonRef}
      >
        {children("fill")}
      </FieldFullScreenDialog>
    </div>
  );
}
