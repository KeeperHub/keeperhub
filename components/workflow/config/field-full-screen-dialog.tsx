"use client";

import {
  Content as DialogContent,
  Root as DialogRoot,
  Title as DialogTitle,
} from "@radix-ui/react-dialog";
import { useAtomValue } from "jotai";
import { Minimize2 } from "lucide-react";
import { useState } from "react";
import { DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { TemplateAutocompletePortalContext } from "@/components/ui/template-autocomplete";
import { FieldToolbarButton } from "@/components/workflow/config/field-toolbar-button";
import { getNodeDisplayName } from "@/lib/workflow/editor/template-helpers";
import { nodesAtom, selectedNodeAtom } from "@/lib/workflow/store";

// Popups an editor opens outside the dialog's own DOM: Monaco's suggestion
// and hover widgets live in one overflow root on <body>.
const OUTSIDE_EDITOR_POPUPS = ".monaco-editor-overflow-widgets-root";

// A popup that Escape should close before it closes the dialog.
const OPEN_EDITOR_POPUPS = [
  "[data-template-autocomplete]",
  `${OUTSIDE_EDITOR_POPUPS} .suggest-widget.visible`,
].join(", ");

// What takes focus when the dialog opens: the input, where typing goes.
const EDITABLE = '[contenteditable="true"], textarea';

function isInsideEditorPopup(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest(OUTSIDE_EDITOR_POPUPS) !== null
  );
}

type FieldFullScreenDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The field's name, shown as the dialog title. */
  label?: string;
  /** The same Beautify control the field's strip shows, or null when it has none. */
  beautifyButton: React.ReactNode;
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
  beautifyButton,
  children,
}: FieldFullScreenDialogProps): React.ReactElement {
  const nodes = useAtomValue(nodesAtom);
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const nodeName = selectedNode ? getNodeDisplayName(selectedNode) : undefined;
  const title = label || "Edit field";

  // The variable picker positions itself against the viewport, so it is
  // portalled into this element rather than <body>, where the modal would make
  // it unreachable. The content has no transform once open, so a fixed
  // position inside it still means the viewport.
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
    null
  );

  return (
    <DialogRoot onOpenChange={onOpenChange} open={open}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent
          aria-describedby={undefined}
          className="fixed inset-8 z-50 flex flex-col overflow-hidden rounded-lg border bg-background shadow-lg"
          data-field-full-screen=""
          onEscapeKeyDown={(event) => {
            if (document.querySelector(OPEN_EDITOR_POPUPS)) {
              event.preventDefault();
            }
          }}
          onInteractOutside={(event) => {
            if (isInsideEditorPopup(event.target)) {
              event.preventDefault();
            }
          }}
          onOpenAutoFocus={(event) => {
            // Radix would focus the first button, and a focused button shows
            // its tooltip - which then takes the first Escape for itself. The
            // input gets focus instead, or the dialog while Monaco loads.
            event.preventDefault();
            const editable =
              portalContainer?.querySelector<HTMLElement>(EDITABLE);
            (editable ?? portalContainer)?.focus();
          }}
          ref={setPortalContainer}
        >
          <div className="flex shrink-0 items-center gap-3 border-b bg-muted/30 py-2 pr-2 pl-4">
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              {nodeName && (
                <>
                  <span className="truncate text-muted-foreground text-sm">
                    {nodeName}
                  </span>
                  <span
                    aria-hidden="true"
                    className="text-muted-foreground text-sm"
                  >
                    /
                  </span>
                </>
              )}
              <DialogTitle className="truncate font-semibold text-sm">
                {title}
              </DialogTitle>
            </div>
            <div className="flex items-center gap-0.5">
              {beautifyButton}
              {beautifyButton && (
                <div aria-hidden="true" className="mx-1 h-3.5 w-px bg-border" />
              )}
              <FieldToolbarButton
                active
                label="Exit full screen"
                onClick={() => onOpenChange(false)}
                tooltip="Exit full screen · Esc"
              >
                <Minimize2 />
              </FieldToolbarButton>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <TemplateAutocompletePortalContext.Provider value={portalContainer}>
              {children}
            </TemplateAutocompletePortalContext.Provider>
          </div>
          <div className="flex shrink-0 items-center justify-between border-t bg-muted/30 px-4 py-1.5 text-muted-foreground text-xs">
            <span>Edits apply to the field as you type</span>
            <span>
              <kbd className="rounded border px-1 font-mono">Esc</kbd> to close
            </span>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  );
}
