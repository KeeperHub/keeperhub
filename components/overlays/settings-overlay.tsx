"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AccountSettings } from "@/components/settings/account-settings";
import { ActiveSessionsSection } from "@/components/settings/active-sessions-section";
import { ChangePasswordSection } from "@/components/settings/change-password-section";
import { DeactivateAccountSection } from "@/components/settings/delete-account-section";
import { TwoFactorSection } from "@/components/settings/two-factor-section";
import { WalletSecuritySection } from "@/components/settings/wallet-security-section";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";
import { useDualFactorState } from "@/lib/mfa/use-dual-factor-state";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

type SettingsOverlayProps = {
  overlayId: string;
};

export function SettingsOverlay({
  overlayId,
}: SettingsOverlayProps): React.ReactElement {
  const { closeAll } = useOverlay();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [accountName, setAccountName] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [originalEmail, setOriginalEmail] = useState("");
  const [providerId, setProviderId] = useState<string | null>(null);
  const dual = useDualFactorState();

  const session = useSession();

  const sessionUser = session.data?.user as
    | { twoFactorEnabled?: boolean | null }
    | undefined;
  const mfaEnrolled = sessionUser?.twoFactorEnabled === true;
  const emailChanged = accountEmail.trim() !== originalEmail;
  const showMfaCode = mfaEnrolled && emailChanged;

  const loadAccount = useCallback(async (): Promise<void> => {
    try {
      const data = await api.user.get();
      setAccountName(data.name || "");
      setAccountEmail(data.email || "");
      setOriginalEmail(data.email || "");
      dual.reset();
      setProviderId(data.providerId ?? null);
    } catch (error) {
      console.error("Failed to load account:", error);
    }
    // dual.reset is a stable closure over useState setters; intentionally
    // excluded from deps to keep this callback referentially stable.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  }, []);

  const loadAll = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      await loadAccount();
    } finally {
      setLoading(false);
    }
  }, [loadAccount]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const saveAccount = async (): Promise<void> => {
    if (showMfaCode && dual.totpCode.trim().length !== 6) {
      toast.error("Enter the 6-digit code from your authenticator");
      return;
    }
    if (
      showMfaCode &&
      dual.awaitingEmailOtp &&
      dual.emailOtp.trim().length !== 6
    ) {
      toast.error("Enter the 6-digit code we emailed you");
      return;
    }
    try {
      setSaving(true);
      const response = await fetch("/api/user", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: accountName,
          email: accountEmail,
          code: showMfaCode ? dual.totpCode.trim() : undefined,
          emailOtp:
            showMfaCode && dual.emailOtp.trim()
              ? dual.emailOtp.trim()
              : undefined,
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
        throw new Error(data.error ?? "Failed to save settings");
      }
      await loadAccount();
      toast.success("Settings saved");
      closeAll();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      console.error("Failed to save account:", error);
      toast.error(message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay
      actions={[
        { label: "Cancel", variant: "outline", onClick: closeAll },
        {
          label: "Save",
          onClick: saveAccount,
          loading: saving,
          disabled: loading,
        },
      ]}
      overlayId={overlayId}
      title="Settings"
    >
      <p className="-mt-2 mb-4 text-muted-foreground text-sm">
        Update your personal information
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <Tabs className="w-full" defaultValue="account">
          <TabsList className="mb-4 w-full">
            <TabsTrigger value="account">Account</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
          </TabsList>

          <TabsContent className="space-y-6" value="account">
            <AccountSettings
              accountEmail={accountEmail}
              accountName={accountName}
              awaitingEmailOtp={dual.awaitingEmailOtp && showMfaCode}
              emailOtp={dual.emailOtp}
              onEmailChange={setAccountEmail}
              onEmailOtpChange={dual.setEmailOtp}
              onNameChange={setAccountName}
              onTotpChange={dual.setTotpCode}
              showMfaCode={showMfaCode}
              totpCode={dual.totpCode}
            />
            <DeactivateAccountSection />
          </TabsContent>

          <TabsContent className="space-y-6" value="security">
            {providerId === "siwe" ? (
              <WalletSecuritySection />
            ) : (
              <>
                <TwoFactorSection />
                <ChangePasswordSection providerId={providerId} />
              </>
            )}
            <ActiveSessionsSection />
          </TabsContent>
        </Tabs>
      )}
    </Overlay>
  );
}
