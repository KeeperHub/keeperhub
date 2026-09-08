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

type Props = {
  email: string;
  ip: string;
  country: string | null;
  next: string;
};

/**
 * Locked-open dual-factor prompt for the IP-verification gate.
 * Posts both codes to /api/user/verify-ip, which only mints the
 * session when the request IP also matches the one pinned in the
 * pending_ip_verify cookie. On success the server returns the
 * redirect path the user originally requested.
 */
export function VerifyIpForm({
  email,
  ip,
  country,
  next,
}: Props): React.ReactElement {
  const router = useRouter();
  const dual = useDualFactorState();
  const [busy, setBusy] = useState(false);

  const handleCopyIp = async (): Promise<void> => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(ip);
      toast.success("IP copied to clipboard");
    } catch {
      toast.error("Couldn't copy IP");
    }
  };

  const endpoint = "/api/user/verify-ip";

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
        if (data.code === "ip_mismatch") {
          toast.error(
            "Complete this step from the same network you signed in from."
          );
          return;
        }
        if (
          data.code === "expired" ||
          data.code === "malformed" ||
          data.code === "bad_signature" ||
          data.code === "no_pending_ip"
        ) {
          toast.error("Verification window expired. Sign in again.");
          if (typeof window !== "undefined") {
            window.location.assign("/");
          }
          return;
        }
        toast.error(data.error ?? "Verification failed");
        return;
      }
      const target = data.redirect || next || "/";
      toast.success("Network verified");
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
          <DialogTitle>Confirm this new sign-in</DialogTitle>
          <DialogDescription>
            We noticed you're signing in from a new network. Please confirm it's
            you by entering the code we just emailed to {email} and the current
            code from your authenticator app.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          <span className="text-muted-foreground">Signing in from</span>
          <button
            className="font-mono text-foreground hover:underline"
            onClick={handleCopyIp}
            title="Copy IP to clipboard"
            type="button"
          >
            {ip}
            {country ? ` (${country})` : ""}
          </button>
        </div>
        <DualFactorSteps
          busy={busy}
          dual={dual}
          onBack={() => {
            if (typeof window !== "undefined") {
              window.location.assign("/");
            }
          }}
          onPrefetchEmail={() => dual.prefetchEmail(emptyCodesFetch)}
          onResendEmail={() => dual.resendEmail(emptyCodesFetch)}
          onSubmit={handleSubmit}
          submitLabel="Verify"
        />
      </DialogContent>
    </Dialog>
  );
}
