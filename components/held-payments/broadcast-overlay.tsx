"use client";

import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DualFactorSteps } from "@/components/auth/dual-factor-steps";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { postHeldPaymentBroadcast } from "@/lib/api-client";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { useSession } from "@/lib/auth-client";
import { handleGuardError } from "@/lib/client/handle-guard-error";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";
import type { HeldPaymentView } from "@/lib/tempo/held-payment-view";
import { runWalletStepUp } from "@/lib/wallet/step-up-client";

// Human "in 3 hours" / "5 minutes ago" from a target unix-seconds instant.
// No date library in the repo, so this uses the built-in Intl.RelativeTimeFormat.
function formatRelative(targetSec: number, nowMs: number): string {
  const diffSec = Math.round(targetSec - nowMs / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs >= 86_400) {
    return rtf.format(Math.round(diffSec / 86_400), "day");
  }
  if (abs >= 3600) {
    return rtf.format(Math.round(diffSec / 3600), "hour");
  }
  if (abs >= 60) {
    return rtf.format(Math.round(diffSec / 60), "minute");
  }
  return rtf.format(diffSec, "second");
}

/**
 * Release a held Tempo payment. Step 1 validates the on-chain window and shows a
 * live countdown; only when the payment is broadcastable AND the user hits
 * Continue do we move to step 2 (dual-factor MFA), which is what emails the
 * code -- so an expired/not-yet-valid hold, or a user who backs out, never
 * spends an email credit. Mirrors export-audit-overlay.
 */
export function BroadcastHeldPaymentOverlay({
  overlayId,
  payment,
  onDone,
}: {
  overlayId: string;
  payment: HeldPaymentView;
  onDone: () => void;
}): React.ReactElement {
  const { pop } = useOverlay();
  const dual = useDualFactorState();
  const session = useSession();
  const isWallet = isWalletEmail(session.data?.user?.email);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [step, setStep] = useState<"confirm" | "mfa">("confirm");
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const nowSec = Math.floor(nowMs / 1000);
  const validAfterSec = payment.validAfter;
  const expired = payment.validBefore <= nowSec;
  const notYetValid = validAfterSec !== null && validAfterSec > nowSec;
  const broadcastable = !(expired || notYetValid);

  const amountLabel =
    payment.amount && payment.tokenSymbol
      ? `${payment.amount} ${payment.tokenSymbol}`
      : (payment.amount ?? "this payment");
  const recipient = `${payment.to.slice(0, 6)}...${payment.to.slice(-4)}`;
  const validBeforeDate = new Date(payment.validBefore * 1000).toLocaleString();

  const post = (extra: {
    code?: string;
    emailOtp?: string;
    signature?: string;
  }): Promise<Response> => postHeldPaymentBroadcast(payment.id, extra);

  const startMfa = (): void => {
    dual.reset();
    setStep("mfa");
  };

  const handleSubmit = async (): Promise<void> => {
    try {
      // Wallet accounts prove step-up with a wallet signature (runWalletStepUp
      // answers the server's signature_required challenge); email/oauth accounts
      // use the dual-factor code + email OTP. Mirrors the withdraw flow.
      const res = isWallet
        ? await runWalletStepUp((extra) => post(extra))
        : await post({
            code: dual.totpCode.trim(),
            emailOtp: dual.emailOtp.trim() || undefined,
          });
      if (!res.ok) {
        if (await handleGuardError(res)) {
          pop();
          return;
        }
        const data = (await res.json()) as { code?: string; error?: string };
        if (
          !isWallet &&
          dual.handleResponse(data.code, data.error, (m) => toast.error(m))
        ) {
          return;
        }
        throw new Error(data.error ?? "Broadcast failed");
      }
      toast.success("Payment broadcast to the network");
      pop();
      onDone();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to broadcast the payment"
      );
    }
  };

  if (step === "mfa") {
    if (isWallet) {
      return (
        <Overlay
          actions={[
            {
              label: "Back",
              onClick: () => setStep("confirm"),
              variant: "outline" as const,
            },
            { label: "Broadcast", onClick: handleSubmit },
          ]}
          overlayId={overlayId}
          title="Broadcast held payment"
        >
          <p className="text-muted-foreground text-sm">
            Broadcast <strong className="text-foreground">{amountLabel}</strong>{" "}
            to <strong className="text-foreground">{recipient}</strong>. This
            releases the pre-signed transaction to the network and cannot be
            undone. Sign with your wallet to continue.
          </p>
        </Overlay>
      );
    }
    return (
      <Overlay overlayId={overlayId} title="Broadcast held payment">
        <DualFactorSteps
          context={
            <>
              Broadcast <strong>{amountLabel}</strong> to{" "}
              <strong>{recipient}</strong>. This releases the pre-signed
              transaction to the network and cannot be undone.
            </>
          }
          dual={dual}
          onBack={() => setStep("confirm")}
          onPrefetchEmail={() => dual.prefetchEmail(() => post({}))}
          onResendEmail={() => dual.resendEmail(() => post({}))}
          onSubmit={handleSubmit}
          submitLabel="Broadcast"
        />
      </Overlay>
    );
  }

  let body: React.ReactElement;
  if (expired) {
    body = (
      <div className="flex gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="size-5 text-destructive" />
        </div>
        <div className="space-y-1">
          <p className="font-medium text-sm">Validity window closed</p>
          <p className="text-muted-foreground text-sm">
            This payment could only settle until {validBeforeDate} (
            {formatRelative(payment.validBefore, nowMs)}). Broadcasting it now
            would be rejected by the network. Cancel it instead.
          </p>
        </div>
      </div>
    );
  } else if (validAfterSec !== null && validAfterSec > nowSec) {
    body = (
      <div className="flex gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
          <AlertTriangle className="size-5 text-amber-600 dark:text-amber-400" />
        </div>
        <div className="space-y-1">
          <p className="font-medium text-sm">Not valid yet</p>
          <p className="text-muted-foreground text-sm">
            This payment can only settle from{" "}
            {new Date(validAfterSec * 1000).toLocaleString()} (
            {formatRelative(validAfterSec, nowMs)}); broadcasting before then
            would be rejected by the network.
          </p>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="space-y-2">
        <p className="text-sm">
          Broadcast <strong>{amountLabel}</strong> to{" "}
          <strong>{recipient}</strong>. This releases the pre-signed transaction
          to the network and cannot be undone.
        </p>
        <p className="text-muted-foreground text-sm">
          The on-chain window closes{" "}
          {formatRelative(payment.validBefore, nowMs)} (at {validBeforeDate}).
          {isWallet
            ? " You will sign with your wallet on the next step."
            : " You will confirm with a verification code on the next step."}
        </p>
      </div>
    );
  }

  const actions = broadcastable
    ? [
        { label: "Cancel", onClick: pop, variant: "outline" as const },
        { label: "Continue", onClick: startMfa },
      ]
    : [{ label: "Close", onClick: pop, variant: "outline" as const }];

  return (
    <Overlay
      actions={actions}
      overlayId={overlayId}
      title="Broadcast held payment"
    >
      {body}
    </Overlay>
  );
}
