"use client";

import type { ChangeEvent, ReactNode } from "react";
import { EmailOtpField } from "@/components/auth/email-otp-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Shared rendering of the dual-factor prompt. Both fields are shown
 * from the start so the user can see up front that two codes are
 * required. The email-code input stays disabled with a "we will send
 * a code when you submit" hint until the server returns
 * `factors_required`; once `awaitingEmailOtp` flips true the input
 * becomes editable and prompts for the code that was just emailed.
 *
 * Styling, sanitisation, and microcopy live here so every sensitive
 * surface (withdraw, export-key, api-keys, settings, change-password,
 * deactivate-account, totp-disable) looks and behaves identically.
 */

type Props = {
  /** Used to namespace input ids so multiple instances on a page do not collide. */
  idPrefix: string;
  totpCode: string;
  onTotpChange: (value: string) => void;
  emailOtp: string;
  onEmailOtpChange: (value: string) => void;
  awaitingEmailOtp: boolean;
  totpLabel?: string;
  emailLabel?: string;
  /** Optional help text rendered under the authenticator input. */
  totpHelp?: ReactNode;
  /**
   * Optional override for the help text rendered under the email
   * input once the code has been sent. Defaults to the standard "We
   * emailed a 6-digit confirmation code" line.
   */
  emailHelp?: ReactNode;
  /**
   * Optional override for the hint shown under the email input
   * BEFORE the server has emailed a code. Defaults to "We will email
   * a code after you submit."
   */
  emailPendingHint?: ReactNode;
  autoFocusTotp?: boolean;
  disabled?: boolean;
};

const INPUT_CLASSES = "font-mono text-center text-lg tracking-[0.3em]";
const DEFAULT_EMAIL_HELP =
  "We emailed a 6-digit confirmation code. Enter it above along with your authenticator code.";
const DEFAULT_EMAIL_PENDING_HINT =
  "We will email a 6-digit code after you submit your authenticator code.";

const numericOnly = (value: string): string => value.replace(/\D/g, "");

export function DualFactorInput({
  idPrefix,
  totpCode,
  onTotpChange,
  emailOtp,
  onEmailOtpChange,
  awaitingEmailOtp,
  totpLabel = "Authenticator code",
  emailLabel = "Email code",
  totpHelp,
  emailHelp,
  emailPendingHint,
  autoFocusTotp,
  disabled,
}: Props): React.ReactElement {
  const totpId = `${idPrefix}-totp`;
  const emailId = `${idPrefix}-email-otp`;

  const handleTotp = (event: ChangeEvent<HTMLInputElement>): void => {
    onTotpChange(numericOnly(event.target.value));
  };

  const emailFieldDisabled = disabled === true || !awaitingEmailOtp;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={totpId}>{totpLabel}</Label>
        <Input
          autoComplete="one-time-code"
          autoFocus={autoFocusTotp === true && !awaitingEmailOtp}
          className={INPUT_CLASSES}
          disabled={disabled}
          id={totpId}
          inputMode="numeric"
          maxLength={6}
          onChange={handleTotp}
          placeholder="000000"
          value={totpCode}
        />
        {totpHelp && (
          <p className="text-muted-foreground text-xs">{totpHelp}</p>
        )}
      </div>
      <div className="space-y-2">
        <EmailOtpField
          autoFocus={awaitingEmailOtp}
          disabled={emailFieldDisabled}
          id={emailId}
          label={emailLabel}
          onChange={onEmailOtpChange}
          value={emailOtp}
        />
        <p className="text-muted-foreground text-xs">
          {awaitingEmailOtp
            ? (emailHelp ?? DEFAULT_EMAIL_HELP)
            : (emailPendingHint ?? DEFAULT_EMAIL_PENDING_HINT)}
        </p>
      </div>
    </div>
  );
}
