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

// Where the window sits on phones (below 640px) and on touch screens: the
// gap above and below it, each set once per screen type. The gap below also
// clears the home bar. A screen 640px or wider with a mouse matches neither,
// so it keeps the centred window and its layout exactly as before.
const PHONE_OFFSETS =
  "max-sm:[--gate-top:calc(env(safe-area-inset-top)+1rem)] max-sm:[--gate-bottom:max(1rem,env(safe-area-inset-bottom))]";
const TOUCH_OFFSETS =
  "sm:touch:[--gate-top:12dvh] sm:touch:[--gate-bottom:max(1rem,env(safe-area-inset-bottom))]";
const PLACEMENT =
  "max-sm:top-(--gate-top) max-sm:max-h-[calc(100dvh-var(--gate-top)-var(--gate-bottom))] max-sm:translate-y-0 max-sm:flex max-sm:flex-col sm:touch:top-(--gate-top) sm:touch:max-h-[calc(100dvh-var(--gate-top)-var(--gate-bottom))] sm:touch:translate-y-0 sm:touch:flex sm:touch:flex-col";

/**
 * The locked-open window of the sign-in gates (/verify-mfa, /verify-ip): no
 * Esc, no outside click and no close button, so the page behind it can't be
 * used without answering it.
 *
 * On phones and touch screens it sits near the top instead of in the middle,
 * so the on-screen keyboard does not cover the code field and the buttons.
 * When it is taller than the space (a phone turned sideways), the title stays
 * and the content below it scrolls.
 */
export function SignInGateDialog({
  title,
  description,
  children,
}: SignInGateDialogProps): React.ReactElement {
  return (
    <Dialog open>
      <DialogContent
        className={`sm:max-w-md ${PHONE_OFFSETS} ${TOUCH_OFFSETS} ${PLACEMENT}`}
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
          className="-m-1 flex min-h-0 flex-col gap-4 p-1 max-sm:overflow-y-auto sm:touch:overflow-y-auto"
          data-testid="sign-in-gate-body"
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
