"use client";

import { Content as DialogContent } from "@radix-ui/react-dialog";
import { useAtomValue } from "jotai";
import { Minimize2 } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { createOverflowWidgetsNode } from "@/components/ui/code-editor";
import {
  Dialog,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EditorPopupContainerContext,
  type EditorPopupContainers,
} from "@/components/ui/editor-popup-container";
import {
  FieldToolbarButton,
  type FieldToolbarButtonHandle,
  FieldToolbarDivider,
} from "@/components/workflow/config/field-toolbar-button";
import { cn } from "@/lib/utils";
import { getNodeDisplayName } from "@/lib/workflow/editor/template-helpers";
import { nodesAtom, selectedNodeAtom } from "@/lib/workflow/store";

// What takes focus when the dialog opens: the input, where typing goes.
// Monaco mounts after the dialog opens and focuses itself when it does.
const EDITABLE = '[contenteditable="true"], textarea';

type FieldFullScreenDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The field's name, shown as the dialog title. */
  label?: string;
  /** Dims the input, as the field itself is dimmed when read-only. */
  disabled?: boolean;
  /** The same Beautify control the field's strip shows, or null when it has none. */
  beautifyButton: React.ReactNode;
  /**
   * Where focus goes when the dialog closes. The dialog is opened from a
   * button that is not a Radix trigger, so Radix cannot find it on its own.
   */
  returnFocusRef: React.RefObject<FieldToolbarButtonHandle | null>;
  /** The field's input, sized to fill the dialog. */
  children: React.ReactNode;
};

/**
 * A config field opened over the whole editor, so a long value can be read
 * and edited with room around it.
 *
 * It is the same field, not a copy to save back: the input writes through the
 * field's own onChange as it is typed in, so closing the dialog by any route
 * keeps every edit.
 */
export function FieldFullScreenDialog({
  open,
  onOpenChange,
  label,
  disabled,
  beautifyButton,
  returnFocusRef,
  children,
}: FieldFullScreenDialogProps): React.ReactElement {
  const [content, setContent] = useState<HTMLElement | null>(null);
  // Created as the dialog opens rather than when its content mounts: Monaco
  // takes this node only when an editor is created, so it has to exist before
  // the editor inside renders for the first time.
  const monacoWidgets = useMemo(
    () => (open ? createOverflowWidgetsNode() : null),
    [open]
  );
  // The Escape that reached this dialog as the topmost layer. Radix reports it
  // on the way down; the dialog closes only if it also comes back up from the
  // focused element, so an Escape an editor handled - which Monaco and the
  // variable picker stop from propagating - leaves the dialog open, whatever
  // widget it closed. With a selection in Monaco that means the first Escape
  // clears the selection and the second closes, as in VS Code.
  const escapeRef = useRef<KeyboardEvent | null>(null);
  const attachMonacoWidgets = useCallback(
    (slot: HTMLDivElement | null): void => {
      if (slot && monacoWidgets) {
        slot.appendChild(monacoWidgets);
      }
    },
    [monacoWidgets]
  );
  // The variable picker positions itself against the viewport, so it goes in
  // the content itself; the content has no transform once open, so a fixed
  // position inside it still means the viewport.
  const popupContainers = useMemo<EditorPopupContainers | null>(
    () => (monacoWidgets ? { popups: content, monacoWidgets } : null),
    [content, monacoWidgets]
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent
          aria-describedby={undefined}
          // `nokey` keeps keys pressed in the dialog off the canvas behind it:
          // React Flow deletes the selected node on Backspace unless the key
          // comes from an input or from inside `.nokey`. Monaco's right-click
          // menu sits in a shadow root that check cannot see into, so the
          // delete keys are also stopped below.
          className="nokey fixed inset-8 z-50 flex flex-col overflow-hidden rounded-lg border bg-background shadow-lg"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocusRef.current?.focusWithoutTooltip();
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            // Focus outside the content - on <body> after a focused element
            // went away - leaves nothing in here to send the key back up.
            if (
              !(event.target instanceof Node && content?.contains(event.target))
            ) {
              onOpenChange(false);
              return;
            }
            escapeRef.current = event;
          }}
          onKeyDown={(event) => {
            if (event.key === "Backspace" || event.key === "Delete") {
              // React's listener for this portal runs on <body>, before React
              // Flow's on document, so the canvas never sees the key.
              event.stopPropagation();
              return;
            }
            if (
              event.key !== "Escape" ||
              event.nativeEvent !== escapeRef.current
            ) {
              return;
            }
            escapeRef.current = null;
            // Monaco's widgets that take focus - its rename box, a focused
            // hover - render in the widget root, outside the editor whose
            // key handling would close them, so their Escape arrives here
            // unhandled. It is still not a request to leave full screen.
            if (
              event.target instanceof Node &&
              monacoWidgets?.contains(event.target)
            ) {
              return;
            }
            onOpenChange(false);
          }}
          onOpenAutoFocus={(event) => {
            // Radix would focus the first button, and a focused button shows
            // its tooltip - which then takes the first Escape for itself. The
            // input gets focus instead, or the dialog until Monaco mounts.
            event.preventDefault();
            const editable = content?.querySelector<HTMLElement>(EDITABLE);
            (editable ?? content)?.focus();
          }}
          ref={setContent}
        >
          <div className="flex shrink-0 items-center gap-3 border-b bg-muted/30 py-2 pr-2 pl-4">
            <FullScreenTitle label={label || "Edit field"} />
            <div className="flex items-center gap-0.5">
              {beautifyButton}
              {beautifyButton && <FieldToolbarDivider />}
              <FieldToolbarButton
                highlighted
                label="Exit full screen"
                onClick={() => onOpenChange(false)}
                tooltip="Exit full screen"
              >
                <Minimize2 />
              </FieldToolbarButton>
            </div>
          </div>
          <div className={cn("min-h-0 flex-1", disabled && "opacity-50")}>
            <EditorPopupContainerContext.Provider value={popupContainers}>
              {children}
            </EditorPopupContainerContext.Provider>
          </div>
          <div className="flex shrink-0 items-center justify-between border-t bg-muted/30 px-4 py-1.5 text-muted-foreground text-xs">
            <span>Edits apply to the field as you type</span>
            <span className="hidden md:inline">
              <kbd className="rounded border px-1 font-mono">Esc</kbd> to close
            </span>
          </div>
          <div
            className="absolute top-0 left-0 z-50"
            ref={attachMonacoWidgets}
          />
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

/**
 * The node and field the dialog is editing. Its own component so the node
 * list is read only while a dialog is open, not by every field on the panel
 * each time a node moves.
 */
function FullScreenTitle({ label }: { label: string }): React.ReactElement {
  const nodes = useAtomValue(nodesAtom);
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const nodeName = selectedNode ? getNodeDisplayName(selectedNode) : undefined;

  return (
    <div className="flex min-w-0 flex-1 items-baseline gap-2">
      {nodeName && (
        <>
          <span className="truncate text-muted-foreground text-sm">
            {nodeName}
          </span>
          <span aria-hidden="true" className="text-muted-foreground text-sm">
            /
          </span>
        </>
      )}
      <DialogTitle className="truncate font-semibold text-sm">
        {label}
      </DialogTitle>
    </div>
  );
}
