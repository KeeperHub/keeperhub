"use client";

import { DualFactorInput } from "@/components/auth/dual-factor-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AccountState } from "../hooks/use-account";

export function ProfileForm({
  account,
  loading = false,
}: {
  account: AccountState;
  /** Renders the real fields, waiting rather than standing in for them. */
  loading?: boolean;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="profile-name">Name</Label>
          <Input
            disabled={loading}
            id="profile-name"
            onChange={(e) => account.setName(e.target.value)}
            placeholder="Your name"
            value={account.name}
          />
          <p className="text-muted-foreground text-xs">
            Shown to other members of your organizations.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="profile-email">Email</Label>
          <Input
            disabled={loading}
            id="profile-email"
            onChange={(e) => account.setEmail(e.target.value)}
            placeholder="you@example.com"
            type="email"
            value={account.email}
          />
          <p className="text-muted-foreground text-xs">
            Used to sign in and to receive security notices.
          </p>
        </div>
      </div>

      {account.showMfaCode && (
        <div className="rounded-lg border bg-muted/20 p-4">
          <p className="mb-3 font-medium text-sm">Confirm the email change</p>
          <p className="mb-3 text-muted-foreground text-xs">
            Changing your sign-in email needs both factors, so a stolen session
            alone cannot redirect password resets.
          </p>
          <DualFactorInput
            awaitingEmailOtp={account.dual.awaitingEmailOtp}
            emailOtp={account.dual.emailOtp}
            idPrefix="profile"
            onEmailOtpChange={account.dual.setEmailOtp}
            onTotpChange={account.dual.setTotpCode}
            totpCode={account.dual.totpCode}
          />
        </div>
      )}

      <div className="flex justify-end gap-2 border-t pt-4">
        <Button
          disabled={!account.dirty || account.saving}
          onClick={account.reset}
          variant="ghost"
        >
          Discard
        </Button>
        <Button
          disabled={!account.dirty || account.saving}
          onClick={account.save}
        >
          {account.saving ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
