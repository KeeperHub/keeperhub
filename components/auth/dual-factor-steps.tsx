"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { UseDualFactorState } from "@/lib/mfa/use-dual-factor-state";

/**
 * Two-step dual-factor wizard.
 *
 *   Step 1 -- Email code. On entry, the parent's `prefetchEmail`
 *             fires so the verifications row is seeded and the user's
 *             inbox already has the code by the time they look at the
 *             step. User enters the 6-digit code from the email and
 *             clicks Continue.
 *   Step 2 -- Authenticator code. User enters the current 6-digit code
 *             from their authenticator app and clicks Confirm. The
 *             parent's `onSubmit` then POSTs the action endpoint with
 *             both codes; the dual-factor server primitive verifies
 *             them atomically.
 *
 * Visual pattern (numbered bubbles, Back / Continue / Confirm) mirrors
 * components/settings/totp-setup-dialog.tsx so the rest of the app
 * stays consistent.
 */

type DualFactorStepsProps = {
  /**
   * Hook instance. The wizard reads totpCode / emailOtp /
   * awaitingEmailOtp and writes via the setters.
   */
  dual: UseDualFactorState;
  /**
   * Fires the empty-codes POST so the server emails the OTP. Called
   * once on entry into step 1. The hook's `prefetchEmail` already
   * guards against duplicate fires.
   */
  onPrefetchEmail: () => Promise<void>;
  /**
   * User-triggered resend on step 1. Bypasses the hook's prefetch
   * guard so a "didn't get the email" click always re-fires.
   */
  onResendEmail: () => Promise<boolean>;
  /**
   * Fires the final POST with both codes. The parent owns the
   * fetcher, response parsing, and success/error handling.
   */
  onSubmit: () => Promise<void>;
  onBack: () => void;
  /**
   * Submit-button label. Defaults to "Confirm".
   */
  submitLabel?: string;
  /**
   * Variant for the submit button on the final step. Defaults to
   * "default"; pass "destructive" for irreversible actions.
   */
  submitVariant?: "default" | "destructive";
  busy?: boolean;
  /**
   * Optional context line shown above step 1. Use it to remind the
   * user what they are confirming (e.g. "Send 12.34 USDC to 0x...").
   */
  context?: ReactNode;
};

type Phase = "email" | "authenticator";

const STEP_DEFS: ReadonlyArray<{ key: Phase; label: string }> = [
  { key: "email", label: "Email code" },
  { key: "authenticator", label: "Authenticator" },
] as const;

type StepStatus = "current" | "done" | "pending";

function bubbleClassFor(status: StepStatus): string {
  if (status === "current") {
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
              <span aria-hidden="true" className="h-px w-6 bg-border" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

const INPUT_CLASSES = "font-mono text-center text-lg tracking-[0.3em]";

// Visual parity with components/ui/input.tsx so the contenteditable div
// in the email step looks identical to a real <Input>. text-indent
// compensates for tracking's trailing letter-space so centered text
// (and the caret) sit visually centered, not slightly right of center.
const EMAIL_FIELD_CLASSES =
  "block h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-center shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 font-mono text-lg tracking-[0.3em] [text-indent:-0.3em]";

const EMAIL_PLACEHOLDER_CLASSES =
  "pointer-events-none absolute inset-0 block select-none px-3 py-1 text-center font-mono text-lg text-muted-foreground tracking-[0.3em] [text-indent:-0.3em]";

const numericOnly = (value: string): string => value.replace(/\D/g, "");

const sanitizeEmailOtp = (raw: string): string => numericOnly(raw).slice(0, 6);

function placeCaretAtEnd(node: HTMLElement): void {
  if (typeof window === "undefined") {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

export function DualFactorSteps({
  dual,
  onPrefetchEmail,
  onResendEmail,
  onSubmit,
  onBack,
  submitLabel = "Confirm",
  submitVariant = "default",
  busy = false,
  context,
}: DualFactorStepsProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("email");
  const [resending, setResending] = useState(false);
  const emailInputRef = useRef<HTMLDivElement>(null);
  const totpInputRef = useRef<HTMLInputElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: prefetch must fire exactly once on mount; the hook guards against duplicate fires.
  useEffect(() => {
    onPrefetchEmail();
  }, []);

  useEffect(() => {
    const target =
      phase === "email" ? emailInputRef.current : totpInputRef.current;
    target?.focus();
  }, [phase]);

  // The email step uses a contenteditable div, not an <input>, so password
  // managers cannot fill it. Sync external value changes (e.g. resend
  // clearing the code) into the DOM, but skip when the user is actively
  // typing to avoid disrupting the caret.
  useEffect(() => {
    const node = emailInputRef.current;
    if (!node) {
      return;
    }
    if (typeof document !== "undefined" && document.activeElement === node) {
      return;
    }
    if (node.textContent !== dual.emailOtp) {
      node.textContent = dual.emailOtp;
    }
  }, [dual.emailOtp]);

  const handleResend = async (): Promise<void> => {
    setResending(true);
    try {
      const ok = await onResendEmail();
      if (ok) {
        dual.setEmailOtp("");
      }
    } finally {
      setResending(false);
    }
  };

  const emailReady = dual.emailOtp.trim().length === 6;
  const totpReady = dual.totpCode.trim().length === 6;

  return (
    <div className="space-y-4">
      <StepIndicator current={phase} />

      {context && <p className="text-muted-foreground text-sm">{context}</p>}

      <div className={phase === "email" ? "space-y-3" : "hidden"}>
        <div className="space-y-2">
          <Label
            className="font-medium text-keeperhub-green-dark"
            htmlFor="dfs-email-verify"
          >
            Email code
          </Label>
          <div className="relative">
            {dual.emailOtp.length === 0 && (
              <div aria-hidden="true" className={EMAIL_PLACEHOLDER_CLASSES}>
                000000
              </div>
            )}
            {/*
              Not an <input>: password managers (1Password, Bitwarden,
              LastPass, Dashlane, etc.) only target input/textarea/select.
              A contenteditable div is fundamentally invisible to their
              autofill, including TOTP-fill, which kept landing the
              authenticator code in this slot.
            */}
            {/* biome-ignore lint/a11y/useSemanticElements: input-equivalent semantics intentionally avoided so password managers cannot fill this field */}
            <div
              aria-label="Email code"
              aria-required="true"
              className={`${EMAIL_FIELD_CLASSES} ${
                busy
                  ? "pointer-events-none cursor-not-allowed opacity-50"
                  : "cursor-text"
              }`}
              contentEditable={!busy}
              id="dfs-email-verify"
              inputMode="numeric"
              onInput={(event) => {
                const node = event.currentTarget;
                const next = sanitizeEmailOtp(node.textContent ?? "");
                if (node.textContent !== next) {
                  node.textContent = next;
                  placeCaretAtEnd(node);
                }
                if (next !== dual.emailOtp) {
                  dual.setEmailOtp(next);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (!busy && emailReady) {
                    setPhase("authenticator");
                  }
                }
              }}
              onPaste={(event) => {
                event.preventDefault();
                const pasted = event.clipboardData.getData("text");
                const sanitized = sanitizeEmailOtp(pasted);
                const node = event.currentTarget;
                node.textContent = sanitized;
                placeCaretAtEnd(node);
                dual.setEmailOtp(sanitized);
              }}
              ref={emailInputRef}
              role="textbox"
              spellCheck={false}
              suppressContentEditableWarning
              tabIndex={busy ? -1 : 0}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs">
              {dual.awaitingEmailOtp
                ? "We just emailed you a 6-digit code. It expires in 5 minutes."
                : "Sending the code to your email..."}
            </p>
            <Button
              disabled={busy || resending}
              onClick={handleResend}
              size="sm"
              type="button"
              variant="ghost"
            >
              {resending ? "Sending..." : "Resend"}
            </Button>
          </div>
        </div>
        <div className="flex justify-between">
          <Button disabled={busy} onClick={onBack} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={busy || !emailReady}
            onClick={() => setPhase("authenticator")}
          >
            Continue
          </Button>
        </div>
      </div>

      <div className={phase === "authenticator" ? "space-y-3" : "hidden"}>
        <div className="space-y-2">
          <Label
            className="font-medium text-keeperhub-green-dark"
            htmlFor="dfs-totp"
          >
            Authenticator code
          </Label>
          <Input
            autoComplete="one-time-code"
            className={INPUT_CLASSES}
            disabled={busy}
            id="dfs-totp"
            inputMode="numeric"
            maxLength={6}
            onChange={(event) =>
              dual.setTotpCode(numericOnly(event.target.value))
            }
            placeholder="000000"
            ref={totpInputRef}
            value={dual.totpCode}
          />
          <p className="text-muted-foreground text-xs">
            Open your authenticator app and enter the code it is showing right
            now.
          </p>
        </div>
        <div className="flex justify-between">
          <Button
            disabled={busy}
            onClick={() => setPhase("email")}
            variant="outline"
          >
            Back
          </Button>
          <Button
            disabled={busy || !(emailReady && totpReady)}
            onClick={onSubmit}
            variant={submitVariant}
          >
            {busy ? "Working..." : submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
