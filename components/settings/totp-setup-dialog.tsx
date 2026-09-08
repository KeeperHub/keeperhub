"use client";

import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { TotpBackupCodesPanel } from "@/components/settings/totp-backup-codes-panel";
import { TotpQr } from "@/components/settings/totp-qr";
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

type SetupResponse = {
  totpUri: string;
  manualEntryKey: string;
};

type EnrollResponse = {
  backupCodes: string[];
};

type Phase = "setup" | "codes";

const STEP_DEFS: ReadonlyArray<{ key: Phase; label: string }> = [
  { key: "setup", label: "Scan & verify" },
  { key: "codes", label: "Download codes" },
] as const;

type StepStatus = "current" | "done" | "pending";

function bubbleClassFor(status: StepStatus): string {
  if (status === "current" || status === "done") {
    return "border-keeperhub-green-dark bg-keeperhub-green text-foreground dark:text-background";
  }
  return "border-border text-foreground";
}

function labelClassFor(status: StepStatus): string {
  if (status === "current") {
    return "font-medium text-foreground";
  }
  return "text-foreground";
}

function statusFor(idx: number, currentIdx: number): StepStatus {
  if (idx === currentIdx) {
    return "current";
  }
  if (idx < currentIdx) {
    return "done";
  }
  return "pending";
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnrolled: () => void;
};

function StepIndicator({ current }: { current: Phase }): React.ReactElement {
  const currentIdx = STEP_DEFS.findIndex((s) => s.key === current);
  return (
    <ol className="flex items-center gap-2 px-1 pb-1 text-xs">
      {STEP_DEFS.map((s, idx) => {
        const status = statusFor(idx, currentIdx);
        const isLast = idx === STEP_DEFS.length - 1;
        return (
          <li className="flex items-center gap-2" key={s.key}>
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full border font-medium text-[10px] ${bubbleClassFor(status)}`}
            >
              {idx + 1}
            </span>
            <span className={labelClassFor(status)}>{s.label}</span>
            {!isLast && (
              <span
                aria-hidden="true"
                className={`h-px w-6 ${status === "done" ? "bg-keeperhub-green" : "bg-border"}`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function TotpSetupDialog({
  open,
  onOpenChange,
  onEnrolled,
}: Props): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("setup");
  const [setupData, setSetupData] = useState<SetupResponse | null>(null);
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyJustCopied, setKeyJustCopied] = useState(false);
  const [didEnroll, setDidEnroll] = useState(false);

  useEffect(() => {
    if (!open || setupData) {
      return;
    }
    let cancelled = false;
    const run = async (): Promise<void> => {
      setBusy(true);
      try {
        const response = await fetch("/api/user/totp/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (cancelled) {
          return;
        }
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(data.error ?? "Failed to start setup");
          onOpenChange(false);
          return;
        }
        const data = (await response.json()) as SetupResponse;
        if (!cancelled) {
          setSetupData(data);
        }
      } finally {
        if (!cancelled) {
          setBusy(false);
        }
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [open, setupData, onOpenChange]);

  const reset = (): void => {
    setPhase("setup");
    setSetupData(null);
    setCode("");
    setBackupCodes(null);
    setBusy(false);
    setDidEnroll(false);
  };

  const closeAndReset = (): void => {
    reset();
    onOpenChange(false);
  };

  const handleVerifyAndEnroll = async (): Promise<void> => {
    setBusy(true);
    try {
      const response = await fetch("/api/user/totp/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(data.error ?? "Invalid code");
        return;
      }
      const data = (await response.json()) as EnrollResponse;
      setBackupCodes(data.backupCodes);
      setPhase("codes");
      setDidEnroll(true);
    } finally {
      setBusy(false);
    }
  };

  const handleCopyKey = async (): Promise<void> => {
    if (!setupData) {
      return;
    }
    try {
      await navigator.clipboard.writeText(setupData.manualEntryKey);
      toast.success("Setup key copied to clipboard");
      setKeyJustCopied(true);
    } catch {
      toast.error("Copy failed");
    }
  };

  useEffect(() => {
    if (!keyJustCopied) {
      return;
    }
    const timer = window.setTimeout(() => setKeyJustCopied(false), 3000);
    return () => window.clearTimeout(timer);
  }, [keyJustCopied]);

  const handleDone = (): void => {
    toast.success("Two-factor authentication is enabled");
    // flushSync ensures the parent's setEnrolled(true) is applied before
    // closeAndReset calls onOpenChange(false). Without it, React batches the
    // update and the parent's handleOpenChange sees enrolled=false (stale
    // closure) and refuses to close the dialog.
    flushSync(() => {
      onEnrolled();
    });
    closeAndReset();
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          // If the user enrolled but closed via X instead of the Done button,
          // still fire onEnrolled so the parent updates its state.
          if (didEnroll) {
            flushSync(() => {
              onEnrolled();
            });
          }
          closeAndReset();
          return;
        }
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up two-factor authentication</DialogTitle>
          <DialogDescription>
            Scan the QR with an authenticator app and verify a code. Save your
            backup codes after.
          </DialogDescription>
        </DialogHeader>

        <StepIndicator current={phase} />

        {phase === "setup" && (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              Scan the QR code in your authenticator app (Google Authenticator,
              1Password, Authy), or paste the setup key.
            </p>
            <div className="flex justify-center">
              {setupData ? (
                <TotpQr data={setupData.totpUri} />
              ) : (
                <div className="flex h-48 w-48 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground text-xs">
                  {busy ? "Generating QR..." : "Preparing"}
                </div>
              )}
            </div>
            {setupData && (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <span>Setup key</span>
                <button
                  aria-label="Copy setup key"
                  className={`h-7 flex-1 cursor-pointer truncate rounded border bg-muted/30 px-2 text-left font-mono text-foreground text-xs transition-colors ${
                    keyJustCopied
                      ? "border-emerald-500"
                      : "border-border hover:border-foreground/30"
                  }`}
                  onClick={handleCopyKey}
                  type="button"
                >
                  {setupData.manualEntryKey}
                </button>
                <Button
                  aria-label="Copy setup key"
                  className="size-7"
                  onClick={handleCopyKey}
                  size="icon"
                  variant="ghost"
                >
                  <Copy aria-hidden="true" className="size-3.5" />
                </Button>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="totp-verify-code">Verification code</Label>
              <Input
                autoComplete="one-time-code"
                disabled={busy || !setupData}
                id="totp-verify-code"
                inputMode="numeric"
                maxLength={6}
                onChange={(event) =>
                  setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder="123456"
                value={code}
              />
              <p className="text-muted-foreground text-xs">
                Open your authenticator app and enter the code it is showing
                right now.
              </p>
            </div>
            <DialogFooter>
              <Button onClick={closeAndReset} variant="outline">
                Cancel
              </Button>
              <Button
                disabled={busy || !setupData || code.trim().length < 6}
                onClick={handleVerifyAndEnroll}
              >
                {busy ? "Verifying..." : "Continue"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {phase === "codes" && backupCodes && (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              Two-factor is enabled. Save these codes for recovery if you lose
              your authenticator. Regenerate later from settings.
            </p>
            <TotpBackupCodesPanel codes={backupCodes} />
            <DialogFooter>
              <Button
                className="bg-keeperhub-green text-foreground hover:bg-keeperhub-green-dark dark:text-background"
                onClick={handleDone}
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
