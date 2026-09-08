"use client";

import { useState } from "react";
import { ChangePasswordSection } from "@/components/settings/change-password-section";
import { WalletSecuritySection } from "@/components/settings/wallet-security-section";
import { cn } from "@/lib/utils";
import { useAccount } from "./hooks/use-account";
import { type SessionRow, useSecurity } from "./hooks/use-security";
import { EmptyState, SectionHeader, SettingsCard, VEILED } from "./section";
import { RevokeSessionPanel } from "./security/revoke-session-panel";
import { SessionsTable } from "./security/sessions-table";
import { TwoFactorCard } from "./security/two-factor-card";
import { TableSkeleton } from "./skeletons";

export function SecuritySection(): React.ReactElement {
  const { providerId, loading } = useAccount();
  const security = useSecurity();
  const [revoking, setRevoking] = useState<SessionRow | null>(null);
  const isWalletAccount = providerId === "siwe";

  return (
    <>
      <SectionHeader
        description="What it takes to sign in as you, and which devices currently can."
        title="Account security"
      />

      {isWalletAccount ? (
        <SettingsCard
          description="Your wallet signature is the first factor. Add a recovery email or an authenticator for step-up."
          title="Wallet step-up"
        >
          <WalletSecuritySection />
        </SettingsCard>
      ) : (
        <>
          <TwoFactorCard
            loading={security.totpLoading}
            onChanged={security.reloadTotp}
            status={security.totp}
          />
          <SettingsCard
            description="Changing your password signs out every other device."
            title="Password"
          >
            {/* What this renders depends on the sign-in method, which is not
                known yet, so the wait is shaped like the shorter of the two. */}
            {loading ? (
              <div className="space-y-2">
                <span
                  className={cn("ml-1 block w-fit font-medium text-sm", VEILED)}
                >
                  Password
                </span>
                <p
                  className={cn("w-fit text-muted-foreground text-sm", VEILED)}
                >
                  Checking how this account signs in, so the right control can
                  be offered here.
                </p>
              </div>
            ) : (
              <ChangePasswordSection providerId={providerId} />
            )}
          </SettingsCard>
        </>
      )}

      <SettingsCard
        bodyClassName="p-2"
        description="Every browser and device currently holding a session for this account."
        title="Active sessions"
      >
        {security.sessionsLoading && (
          <TableSkeleton columns={4} lines={2} rows={2} />
        )}
        {!security.sessionsLoading && security.sessions.length === 0 && (
          <EmptyState>No other sessions are active.</EmptyState>
        )}
        {!security.sessionsLoading && security.sessions.length > 0 && (
          <>
            <SessionsTable
              onRevoke={setRevoking}
              sessions={security.sessions}
            />
            {revoking && (
              <RevokeSessionPanel
                onCancel={() => setRevoking(null)}
                onDone={async () => {
                  setRevoking(null);
                  await security.reloadSessions();
                }}
                session={revoking}
              />
            )}
          </>
        )}
      </SettingsCard>
    </>
  );
}
