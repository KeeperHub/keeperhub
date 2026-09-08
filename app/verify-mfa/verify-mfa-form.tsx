"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DualFactorSteps } from "@/components/auth/dual-factor-steps";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";

type Mode = "stepup" | "oauth";

type Props = {
  next: string;
  mode: Mode;
};

/**
 * Step-up MFA modal. Routes the codes to one of two endpoints
 * depending on how the user landed here:
 *
 *   - mode="stepup": already-signed-in user with sessions.requires_mfa
 *     = true. POSTs /api/user/totp/verify-stepup which clears the flag
 *     on the existing session.
 *   - mode="oauth": user just finished an OAuth callback that we
 *     intercepted because they have TOTP enrolled. They carry only
 *     the signed `pending_oauth_mfa` cookie, no session. POSTs
 *     /api/auth/oauth-mfa-finalize which atomically verifies both
 *     codes AND mints the session for the first time.
 *
 * Rendered as a locked-open Dialog (no Esc, no outside-click,
 * close button hidden) so the underlying page can't be visually
 * composed with the prompt.
 */
export function VerifyMfaForm({ next, mode }: Props): React.ReactElement {
  const router = useRouter();
  const dual = useDualFactorState();
  const [busy, setBusy] = useState(false);

  const endpoint =
    mode === "oauth"
      ? "/api/auth/oauth-mfa-finalize"
      : "/api/user/totp/verify-stepup";

  const emptyCodesFetch = (): Promise<Response> =>
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

  const handleSubmit = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: dual.totpCode.trim(),
          emailOtp: dual.emailOtp.trim() || undefined,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        redirect?: string;
      };
      if (!response.ok) {
        if (
          dual.handleResponse(data.code, data.error, (msg) => toast.error(msg))
        ) {
          return;
        }
        toast.error(data.error ?? "Invalid code");
        return;
      }
      const target = data.redirect || next || "/";
      if (typeof window !== "undefined") {
        window.location.assign(target);
        return;
      }
      router.replace(target);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open>
      <DialogContent
        className="sm:max-w-md [&>button[type='button']]:hidden"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Confirm it's you</DialogTitle>
          <DialogDescription>
            Enter the code we just emailed you and the current code from your
            authenticator app to continue.
          </DialogDescription>
        </DialogHeader>
        <DualFactorSteps
          busy={busy}
          dual={dual}
          onBack={() => router.replace("/")}
          onPrefetchEmail={() => dual.prefetchEmail(emptyCodesFetch)}
          onResendEmail={() => dual.resendEmail(emptyCodesFetch)}
          onSubmit={handleSubmit}
          submitLabel="Verify"
        />
      </DialogContent>
    </Dialog>
  );
}
