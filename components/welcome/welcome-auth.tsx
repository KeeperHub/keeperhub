"use client";

import { SignInChoices } from "@/components/auth/sign-in-choices";
import { KeeperHubLogo } from "@/components/icons/keeperhub-logo";
import { authClient } from "@/lib/auth-client";
import { markContinueAsGuest } from "@/lib/welcome-status";

/**
 * Full-screen welcome / sign-in surface for the bare-layout /welcome route:
 * the KeeperHub mark, a single title, the shared SignInChoices panel, and a
 * guest escape hatch.
 */
export function WelcomeAuth(): React.ReactElement {
  // Mint the anonymous session before leaving so the request to "/" carries a
  // cookie; the proxy then lets it through and the client gate honors the guest
  // flag instead of bouncing back here.
  const continueWithoutAccount = async (): Promise<void> => {
    markContinueAsGuest();
    try {
      await authClient.signIn.anonymous();
    } catch {
      // Fall through: the client gate still handles the no-session case.
    }
    window.location.assign("/");
  };

  return (
    <div className="flex w-full max-w-sm flex-col gap-6">
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <KeeperHubLogo className="size-9" />
          <h1 className="font-semibold text-2xl tracking-tight">
            Sign in to KeeperHub
          </h1>
        </div>
        <SignInChoices />
      </div>

      <button
        className="text-center text-muted-foreground text-sm hover:text-foreground"
        onClick={continueWithoutAccount}
        type="button"
      >
        Explore without signing in
      </button>
    </div>
  );
}
