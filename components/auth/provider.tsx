"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useState,
} from "react";
import { AuthDialog, type AuthPromptIntent } from "@/components/auth/dialog";

type AuthPromptContextValue = {
  /** Programmatically open the shared auth modal. NAV-02/NAV-06. */
  openAuthPrompt: (intent?: AuthPromptIntent) => void;
};

const AuthPromptContext = createContext<AuthPromptContextValue | null>(null);

/**
 * Wraps children with an AuthPromptContext + a single controlled <AuthDialog />.
 * Any descendant can call useAuthPrompt() to programmatically open the auth
 * modal — used today by sidebar requireAuth nav clicks (Phase 42), and in
 * Phase 43 by the Hub Use-template CTA.
 *
 * Locked decision (CONTEXT.md, NAV-02/NAV-06): we do NOT create a new
 * SignInPromptOverlay component; we reuse the existing AuthDialog via this
 * provider's controlled mount.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<AuthPromptIntent | undefined>(undefined);

  const openAuthPrompt = useCallback((next?: AuthPromptIntent) => {
    setIntent(next);
    setOpen(true);
  }, []);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setIntent(undefined);
    }
  }, []);

  return (
    <AuthPromptContext.Provider value={{ openAuthPrompt }}>
      {children}
      <AuthDialog
        controlledOpen={open}
        intent={intent}
        onControlledOpenChange={handleOpenChange}
      />
    </AuthPromptContext.Provider>
  );
}

/**
 * Returns { openAuthPrompt } so any descendant of AuthProvider can
 * programmatically surface the auth modal. Throws when called outside
 * AuthProvider so misuse fails fast in dev.
 */
export function useAuthPrompt(): AuthPromptContextValue {
  const ctx = useContext(AuthPromptContext);
  if (ctx === null) {
    throw new Error(
      "useAuthPrompt must be used inside <AuthProvider>. Mount the provider in app/layout.tsx."
    );
  }
  return ctx;
}
