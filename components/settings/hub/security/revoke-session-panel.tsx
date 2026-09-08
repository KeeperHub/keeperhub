"use client";

import { useState } from "react";
import { toast } from "sonner";
import { DualFactorSteps } from "@/components/auth/dual-factor-steps";
import { Button } from "@/components/ui/button";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { useSession } from "@/lib/auth-client";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";
import { runWalletStepUp } from "@/lib/wallet/step-up-client";
import type { SessionRow } from "../hooks/use-security";

/**
 * Revoking a session is a step-up action, so it confirms in place under the
 * table rather than opening a dialog.
 */
export function RevokeSessionPanel({
  session,
  onDone,
  onCancel,
}: {
  session: SessionRow;
  onDone: () => Promise<void>;
  onCancel: () => void;
}): React.ReactElement {
  const dual = useDualFactorState();
  const [busy, setBusy] = useState(false);
  const { data } = useSession();
  const isWallet = isWalletEmail(data?.user?.email);
  const endpoint = `/api/user/sessions/${session.id}/revoke`;

  const post = (body: Record<string, unknown>): Promise<Response> =>
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const finish = async (res: Response): Promise<void> => {
    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    if (!res.ok) {
      if (
        dual.handleResponse(payload.code, payload.error, (m) => toast.error(m))
      ) {
        return;
      }
      toast.error(payload.error ?? "Failed to revoke session");
      return;
    }
    toast.success("Session revoked");
    await onDone();
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = isWallet
        ? await runWalletStepUp((extra) => post(extra))
        : await post({
            code: dual.totpCode.trim(),
            emailOtp: dual.emailOtp.trim() || undefined,
          });
      await finish(res);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="m-2 rounded-lg border border-destructive/40 bg-destructive/[0.04] p-4">
      <p className="mb-3 font-medium text-sm">
        Revoke this session? The device will be signed out immediately.
      </p>
      {isWallet ? (
        <div className="flex gap-2">
          <Button disabled={busy} onClick={submit} variant="destructive">
            {busy ? "Revoking..." : "Sign to revoke"}
          </Button>
          <Button disabled={busy} onClick={onCancel} variant="ghost">
            Cancel
          </Button>
        </div>
      ) : (
        <DualFactorSteps
          busy={busy}
          dual={dual}
          onBack={onCancel}
          onPrefetchEmail={() => dual.prefetchEmail(() => post({}))}
          onResendEmail={() => dual.resendEmail(() => post({}))}
          onSubmit={submit}
          submitLabel="Revoke session"
          submitVariant="destructive"
        />
      )}
    </div>
  );
}
