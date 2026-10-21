"use client";

import { type ReactNode, useState } from "react";
import { SignInChoices } from "@/components/auth/sign-in-choices";
import { KeeperHubLogo } from "@/components/icons/keeperhub-logo";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export type AuthPromptIntent = {
  action?: string;
  redirectTo?: string;
};

// --- Auth-flow-in-progress tracking --------------------------------------
// ConnectAuthPanel flips connectPanelActive for as long as it is mounted so
// surfaces like the user menu know an auth flow is mid-air and must not be
// torn down by a session refetch. Kept here so importers have one source.
let connectPanelActive = false;
export const setConnectPanelActive = (active: boolean): void => {
  connectPanelActive = active;
};
export const isAuthFlowInProgress = (): boolean => connectPanelActive;
// Retained for API compatibility. The single-provider auto-initiate UI was
// removed when every auth surface moved to the shared SignInChoices.
export const isSingleProviderSignInInitiated = (): boolean => false;

type AuthDialogProps = {
  children?: ReactNode;
  /**
   * Controlled mode: `controlledOpen` drives the open state and
   * `onControlledOpenChange` fires on every change. Used by
   * AuthProvider/useAuthPrompt for programmatic open. When absent, the dialog
   * manages its own open state and `children` is the trigger.
   */
  controlledOpen?: boolean;
  onControlledOpenChange?: (open: boolean) => void;
  /**
   * Post-sign-in routing hint. `redirectTo` sends the user back to where they
   * started the flow (e.g. an accept-invite page) instead of the default "/".
   * The onboarding-aware gate still runs at the destination.
   */
  intent?: AuthPromptIntent;
};

/**
 * App-wide auth modal. Presents the shared SignInChoices interface -- the same
 * one the welcome page uses -- so every entry point (the Connect button, sidebar
 * requireAuth nav, activity, use-template, accept-invite, add-connection, the
 * device page) shows an identical sign-in surface. Supports controlled mode
 * (AuthProvider) and an uncontrolled trigger passed as children.
 */
export const AuthDialog = ({
  children,
  controlledOpen,
  onControlledOpenChange,
  intent,
}: AuthDialogProps): React.ReactElement => {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (next: boolean): void => {
    if (isControlled) {
      onControlledOpenChange?.(next);
    } else {
      setInternalOpen(next);
    }
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      {children ? <DialogTrigger asChild>{children}</DialogTrigger> : null}
      {/* Scrolls instead of growing past a short screen (a small phone, or one
          turned sideways), where the window is taller than the screen in
          every view, sign-up with the compact captcha most of all; the close
          button and Create account would be out of reach. Phones get the
          tighter padding the welcome card uses. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-6 overflow-y-auto p-6 sm:max-w-md sm:gap-8 sm:p-8">
        <DialogHeader className="flex flex-col items-center gap-4">
          <KeeperHubLogo className="size-10" />
          <DialogTitle className="text-2xl">Sign in to KeeperHub</DialogTitle>
        </DialogHeader>
        <SignInChoices redirectTo={intent?.redirectTo} />
      </DialogContent>
    </Dialog>
  );
};
