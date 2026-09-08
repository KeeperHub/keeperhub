import { DualFactorInput } from "@/components/auth/dual-factor-input";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AccountSettingsProps = {
  accountName: string;
  accountEmail: string;
  /**
   * Set when the user has TOTP enrolled AND the email field has
   * diverged from its loaded value. Triggers the inline TOTP and
   * (after the server emails an OTP) the email-code prompt. The
   * server requires both factors for email change so a stolen
   * session alone cannot redirect password-reset to an attacker
   * mailbox.
   */
  showMfaCode?: boolean;
  /**
   * True after the server has emailed a confirmation code in
   * response to a first save attempt. Reveals the email-code input.
   */
  awaitingEmailOtp?: boolean;
  totpCode?: string;
  emailOtp?: string;
  onNameChange: (name: string) => void;
  onEmailChange: (email: string) => void;
  onTotpChange?: (code: string) => void;
  onEmailOtpChange?: (code: string) => void;
};

export function AccountSettings({
  accountName,
  accountEmail,
  showMfaCode,
  awaitingEmailOtp,
  totpCode,
  emailOtp,
  onNameChange,
  onEmailChange,
  onTotpChange,
  onEmailOtpChange,
}: AccountSettingsProps): React.ReactElement {
  return (
    <Card className="border-0 py-0 shadow-none">
      <CardContent className="space-y-4 p-0">
        <div className="space-y-2">
          <Label className="ml-1" htmlFor="accountName">
            Name
          </Label>
          <Input
            id="accountName"
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Your name"
            value={accountName}
          />
        </div>

        <div className="space-y-2">
          <Label className="ml-1" htmlFor="accountEmail">
            Email
          </Label>
          <Input
            id="accountEmail"
            onChange={(e) => onEmailChange(e.target.value)}
            placeholder="your.email@example.com"
            type="email"
            value={accountEmail}
          />
        </div>

        {showMfaCode && (
          <DualFactorInput
            awaitingEmailOtp={awaitingEmailOtp === true}
            emailHelp="We emailed a 6-digit confirmation code. Enter it along with your authenticator code."
            emailLabel="Email code (required to change email)"
            emailOtp={emailOtp ?? ""}
            idPrefix="account"
            onEmailOtpChange={(value) => onEmailOtpChange?.(value)}
            onTotpChange={(value) => onTotpChange?.(value)}
            totpCode={totpCode ?? ""}
            totpLabel="Authenticator code (required to change email)"
          />
        )}
      </CardContent>
    </Card>
  );
}
