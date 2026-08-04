"use client";

import { Copy, Eye, EyeOff, KeyRound, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DualFactorSteps } from "@/components/auth/dual-factor-steps";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { SettingsOverlay } from "@/components/overlays/settings-overlay";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useSession } from "@/lib/auth-client";
import { handleGuardError } from "@/lib/client/handle-guard-error";
import { useActiveMember } from "@/lib/hooks/use-organization";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";

type ExportStep = "idle" | "select-key" | "totp" | "verifying" | "done" | "needs-mfa";
type ExportKeyType = "evm" | "solana";

export function ExportPrivateKeyButton({
  solanaAddress,
}: {
  solanaAddress?: string | null;
}): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<ExportStep>("idle");
  const [keyType, setKeyType] = useState<ExportKeyType>("evm");
  const dual = useDualFactorState();
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { open: openOverlay } = useOverlay();
  const router = useRouter();

  // Client-side pre-check: hide the button entirely for non-owners
  // and route owners-without-MFA to enrollment instead of the TOTP
  // dialog. Server still enforces the same rules via
  // requireOwnerWithMfa, so this is purely UX hardening — never the
  // sole source of authorization.
  const { role, isLoading: memberLoading } = useActiveMember();
  const session = useSession();
  const sessionUser = session.data?.user as
    | { twoFactorEnabled?: boolean | null }
    | undefined;
  const isOwner = role === "owner";
  const mfaEnrolled = sessionUser?.twoFactorEnabled === true;

  if (memberLoading || session.isPending) {
    return null;
  }
  if (!isOwner) {
    return null;
  }

  const guardOptions = {
    onEnrollMfa: () => {
      setOpen(false);
      openOverlay(SettingsOverlay);
    },
    onPendingMfa: (next: string) => {
      setOpen(false);
      router.push(`/verify-mfa?next=${encodeURIComponent(next)}`);
    },
  };

  const hasSolanaAccount = Boolean(solanaAddress);
  const exportLabel =
    keyType === "solana" ? "Export Solana Private Key" : "Export EVM Private Key";
  const keyTypeLabel =
    keyType === "solana" ? "Solana private key" : "EVM private key";

  const handleOpen = (): void => {
    setOpen(true);
    setError(null);
    dual.reset();
    setPrivateKey(null);
    setRevealed(false);
    setKeyType("evm");
    if (!mfaEnrolled) {
      setStep("needs-mfa");
      return;
    }
    setStep(hasSolanaAccount ? "select-key" : "totp");
  };

  const handleVerify = async (): Promise<void> => {
    if (dual.totpCode.length !== 6) {
      setError("Enter the 6-digit code from your authenticator app");
      return;
    }
    if (dual.awaitingEmailOtp && dual.emailOtp.length !== 6) {
      setError("Enter the 6-digit code we emailed you");
      return;
    }

    setStep("verifying");
    setError(null);
    try {
      const res = await fetch("/api/user/wallet/export-key/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: dual.totpCode,
          emailOtp: dual.emailOtp || undefined,
          keyType,
        }),
      });

      if (!res.ok) {
        const guarded = await handleGuardError(res, guardOptions);
        if (guarded) {
          setStep("totp");
          return;
        }
        const data: { error?: string; code?: string } = await res.json();
        if (
          dual.handleResponse(data.code, data.error, (msg) => setError(msg))
        ) {
          setStep("totp");
          return;
        }
        throw new Error(data.error ?? "Verification failed");
      }

      const data: { privateKey?: string } = await res.json();
      if (!data.privateKey) {
        throw new Error("No private key returned");
      }

      setPrivateKey(data.privateKey);
      setRevealed(false);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
      setStep("totp");
    }
  };

  const handleCopy = (): void => {
    if (!privateKey) {
      return;
    }
    navigator.clipboard.writeText(privateKey);
    toast.success("Private key copied to clipboard");
  };

  const handleClose = (): void => {
    setOpen(false);
    setStep("idle");
    dual.reset();
    setPrivateKey(null);
    setRevealed(false);
    setError(null);
  };

  const description = (() => {
    if (step === "done") {
      return `Your ${keyTypeLabel} is shown below. Copy it and store it securely.`;
    }
    if (step === "needs-mfa") {
      return "Enable two-factor authentication on your account before exporting a private key.";
    }
    if (step === "select-key") {
      return "Choose which account key to export, then confirm with your authenticator.";
    }
    return `Enter the current 6-digit code from your authenticator app to export your ${keyTypeLabel}.`;
  })();

  return (
    <>
      <Button
        className="w-full"
        onClick={handleOpen}
        size="sm"
        variant="outline"
      >
        <KeyRound className="mr-2 h-3 w-3" />
        Export Private Key
      </Button>

      <Dialog
        onOpenChange={(v) => {
          if (!v) {
            handleClose();
          }
        }}
        open={open}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{exportLabel}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          {step === "select-key" && (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="export-key-type">Key type</Label>
                <Select
                  onValueChange={(value: ExportKeyType) => setKeyType(value)}
                  value={keyType}
                >
                  <SelectTrigger id="export-key-type">
                    <SelectValue placeholder="Select key type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="evm">EVM private key</SelectItem>
                    <SelectItem value="solana">Solana private key</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button onClick={handleClose} variant="outline">
                  Cancel
                </Button>
                <Button onClick={() => setStep("totp")} variant="destructive">
                  Continue
                </Button>
              </DialogFooter>
            </div>
          )}

          {step === "needs-mfa" && (
            <div className="space-y-4 py-2">
              <div className="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-4">
                <ShieldAlert
                  aria-hidden="true"
                  className="mt-0.5 size-5 shrink-0 text-amber-500"
                />
                <p className="text-sm">
                  Exporting a private key requires a second factor. Open
                  Settings to enroll your authenticator, then come back to
                  finish the export.
                </p>
              </div>
              <DialogFooter>
                <Button onClick={handleClose} variant="outline">
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    handleClose();
                    openOverlay(SettingsOverlay);
                  }}
                >
                  Open Settings
                </Button>
              </DialogFooter>
            </div>
          )}

          {(step === "totp" || step === "verifying") && (
            <div className="space-y-4 py-2">
              <DualFactorSteps
                busy={step === "verifying"}
                dual={dual}
                onBack={handleClose}
                onPrefetchEmail={() =>
                  dual.prefetchEmail(() =>
                    fetch("/api/user/wallet/export-key/verify", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({}),
                    })
                  )
                }
                onResendEmail={() =>
                  dual.resendEmail(() =>
                    fetch("/api/user/wallet/export-key/verify", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({}),
                    })
                  )
                }
                onSubmit={handleVerify}
                submitLabel={`Export ${keyType === "solana" ? "Solana" : "EVM"} private key`}
                submitVariant="destructive"
              />
              {error && <p className="text-destructive text-sm">{error}</p>}
            </div>
          )}

          {step === "done" && privateKey && (
            <div className="space-y-4 py-2">
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium text-destructive text-sm">
                    {keyType === "solana" ? "Solana Private Key" : "EVM Private Key"}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      aria-label={
                        revealed ? "Hide private key" : "Reveal private key"
                      }
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setRevealed(!revealed)}
                      type="button"
                    >
                      {revealed ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                    <button
                      aria-label="Copy private key"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={handleCopy}
                      type="button"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <code className="block break-all font-mono text-sm">
                  {revealed ? privateKey : privateKey.replace(/./g, "•")}
                </code>
              </div>
              <Button className="w-full" onClick={handleClose}>
                Done
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
