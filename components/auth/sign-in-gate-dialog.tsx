"use client";

import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type SignInGateDialogProps = {
  title: string;
  description: ReactNode;
  children: ReactNode;
};

/**
 * The locked-open window of the sign-in gates (/verify-mfa, /verify-ip): no
 * Esc, no outside click and no close button, so the page behind it can't be
 * used without answering it.
 *
 * On phones and touch screens DialogContent's keyboard-safe-window places it
 * near the top, above the on-screen keyboard, and the window scrolls as one
 * so a focused field can always be brought into view. Because nothing can
 * close it, it is also never taller than the screen with a mouse: in a short
 * or zoomed desktop window the title stays and the content below it scrolls.
 */
export function SignInGateDialog({
  title,
  description,
  children,
}: SignInGateDialogProps): React.ReactElement {
  return (
    <Dialog open>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-md"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* -m-1 p-1 keeps the fields' focus rings clear of the scroll edge. */}
        <div
          className="-m-1 flex min-h-0 flex-col gap-4 overflow-y-auto p-1 soft-keyboard:min-h-auto soft-keyboard:overflow-visible"
          data-testid="sign-in-gate-body"
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
