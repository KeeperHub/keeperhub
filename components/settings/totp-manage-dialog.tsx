"use client";

import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DualFactorSteps } from "@/components/auth/dual-factor-steps";
import { TotpBackupCodesPanel } from "@/components/settings/totp-backup-codes-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";

type Mode = "summary" | "generate-codes" | "viewing-codes" | "disable";

type StatusInfo = {
  name: string | null;
  enrolledAt: string | null;
  hasBackupCodes: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: StatusInfo;
  onChanged: () => void;
};

function formatDate(iso: string | null): string {
  if (!iso) {
    return "Unknown";
  }
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function TotpManageDialog({
  open,
  onOpenChange,
  status,
  onChanged,
}: Props): React.ReactElement {
  const [mode, setMode] = useState<Mode>("summary");
  const [code, setCode] = useState("");
  const [generatedCodes, setGeneratedCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Disable is gated by the same dual-factor primitive used for
  // withdraw / export-key / api-keys, so disabling MFA can't be done
  // with a stolen session plus a single TOTP code.
  const dual = useDualFactorState();

  // Locked: backup codes are on-screen but the user hasn't completed
  // copy + download + retype-confirm yet. Closing the dialog, navigating
  // away, refreshing the tab, or even clicking the backdrop in this
  // state loses the codes forever (we never re-display them). The
  // beforeunload listener below traps hard navigation; the
  // onOpenChange interceptor traps soft close attempts.
  const locked = mode === "viewing-codes" && generatedCodes !== null;

  useEffect(() => {
    if (!locked) {
      return;
    }
    const handler = (event: BeforeUnloadEvent): string => {
      event.preventDefault();
      // Chrome ignores the message; setting returnValue is what triggers
      // the native confirm dialog.
      event.returnValue =
        "You have unsaved backup codes. Leaving now means losing them.";
      return event.returnValue;
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [locked]);

  const resetAndClose = (): void => {
    setMode("summary");
    setCode("");
    setGeneratedCodes(null);
    setBusy(false);
    dual.reset();
    onOpenChange(false);
  };

  const attemptClose = (): void => {
    if (locked) {
      toast.error(
        "Finish saving your backup codes (copy, download, and confirm two) before closing."
      );
      return;
    }
    resetAndClose();
  };

  const handleGenerateCodes = async (): Promise<void> => {
    setBusy(true);
    try {
      const response = await fetch("/api/user/totp/backup-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(data.error ?? "Failed to generate codes");
        return;
      }
      const data = (await response.json()) as { backupCodes: string[] };
      setGeneratedCodes(data.backupCodes);
      setCode("");
      setMode("viewing-codes");
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async (): Promise<void> => {
    setBusy(true);
    try {
      const response = await fetch("/api/user/totp/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: dual.totpCode.trim(),
          emailOtp: dual.emailOtp.trim() || undefined,
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        if (
          dual.handleResponse(data.code, data.error, (msg) => toast.error(msg))
        ) {
          return;
        }
        toast.error(data.error ?? "Failed to disable");
        return;
      }
      toast.success("Two-factor authentication disabled");
      onChanged();
      resetAndClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          attemptClose();
          return;
        }
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent
        className={
          locked
            ? "sm:max-w-md [&>button[type='button']]:hidden"
            : "sm:max-w-md"
        }
        onEscapeKeyDown={(event) => {
          if (locked) {
            event.preventDefault();
            toast.error("Finish saving your backup codes before closing.");
          }
        }}
        onInteractOutside={(event) => {
          if (locked) {
            event.preventDefault();
            toast.error("Finish saving your backup codes before closing.");
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Manage two-factor authentication</DialogTitle>
          <DialogDescription>
            {mode === "summary" &&
              "Your authenticator is enrolled. You can manage backup codes or disable from here."}
            {mode === "generate-codes" &&
              "Enter your authenticator code to generate a new set of backup codes."}
            {mode === "viewing-codes" &&
              "Save these codes somewhere safe. Each one is single-use."}
            {mode === "disable" &&
              "Enter your authenticator code to confirm. This action removes the second factor entirely."}
          </DialogDescription>
        </DialogHeader>

        {mode === "summary" && (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <div className="flex items-start gap-3">
                <ShieldCheck
                  aria-hidden="true"
                  className="mt-0.5 size-5 text-emerald-500"
                />
                <div className="space-y-1">
                  <div className="font-medium text-sm">
                    {status.name ?? "Authenticator"}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    Enrolled {formatDate(status.enrolledAt)}
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Backup codes</Label>
              <p className="text-muted-foreground text-xs">
                {status.hasBackupCodes
                  ? "Codes are active. Generating new ones invalidates the previous set."
                  : "No backup codes yet. Generate a set you can use if you lose your authenticator."}
              </p>
              <Button
                onClick={() => setMode("generate-codes")}
                size="sm"
                variant="outline"
              >
                {status.hasBackupCodes
                  ? "Regenerate backup codes"
                  : "Generate backup codes"}
              </Button>
            </div>

            <Alert className="border-destructive/40 bg-destructive/5">
              <AlertDescription>
                Turning this off removes the second factor on every sign-in,
                including risky logins from new locations.
              </AlertDescription>
            </Alert>

            <DialogFooter className="sm:justify-between">
              <Button onClick={attemptClose} variant="outline">
                Close
              </Button>
              <Button onClick={() => setMode("disable")} variant="destructive">
                Disable
              </Button>
            </DialogFooter>
          </div>
        )}

        {mode === "generate-codes" && (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="manage-code">Verification code</Label>
              <Input
                autoComplete="one-time-code"
                autoFocus
                id="manage-code"
                inputMode="numeric"
                maxLength={6}
                onChange={(event) => setCode(event.target.value)}
                placeholder="123456"
                value={code}
              />
            </div>
            <DialogFooter>
              <Button
                disabled={busy}
                onClick={() => {
                  setMode("summary");
                  setCode("");
                }}
                variant="outline"
              >
                Back
              </Button>
              <Button
                disabled={busy || code.trim().length < 6}
                onClick={handleGenerateCodes}
              >
                {busy ? "Working..." : "Generate codes"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {mode === "disable" && (
          <div className="space-y-3">
            <DualFactorSteps
              busy={busy}
              dual={dual}
              onBack={() => {
                setMode("summary");
                dual.reset();
                onOpenChange(false);
              }}
              onPrefetchEmail={() =>
                dual.prefetchEmail(() =>
                  fetch("/api/user/totp/disable", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({}),
                  })
                )
              }
              onResendEmail={() =>
                dual.resendEmail(() =>
                  fetch("/api/user/totp/disable", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({}),
                  })
                )
              }
              onSubmit={handleDisable}
              submitLabel="Disable two-factor"
              submitVariant="destructive"
            />
          </div>
        )}

        {mode === "viewing-codes" && generatedCodes && (
          <div className="space-y-4">
            <TotpBackupCodesPanel codes={generatedCodes} />
            <DialogFooter>
              <Button onClick={resetAndClose} variant="outline">
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
