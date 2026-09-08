"use client";

import { ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { TotpManageDialog } from "@/components/settings/totp-manage-dialog";
import { TotpSetupDialog } from "@/components/settings/totp-setup-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TotpStatus } from "../hooks/use-security";
import { SettingsCard, VEILED } from "../section";

export function TwoFactorCard({
  status,
  loading,
  onChanged,
}: {
  status: TotpStatus | null;
  loading: boolean;
  onChanged: () => void;
}): React.ReactElement {
  const [setupOpen, setSetupOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const enabled = status?.enabled ?? false;

  const enrolledDetail = status?.enrolledAt
    ? ` · added ${new Date(status.enrolledAt).toLocaleDateString()}`
    : "";
  const backupDetail = status?.hasBackupCodes ? "" : " · no backup codes";
  const onDetail = `${status?.name ?? "Authenticator"}${enrolledDetail}${backupDetail}`;
  const offDetail =
    "Your password alone can sign you in. Turn this on to require a code too.";

  let detail = "Checking whether a second factor is enrolled";
  if (!loading) {
    detail = enabled ? onDetail : offDetail;
  }

  let stateIcon: React.ReactNode = null;
  if (!loading) {
    stateIcon = enabled ? (
      <ShieldCheck className="size-4" />
    ) : (
      <ShieldOff className="size-4 text-muted-foreground" />
    );
  }

  return (
    <SettingsCard
      action={
        !loading && (
          <Button
            onClick={() => (enabled ? setManageOpen(true) : setSetupOpen(true))}
            size="sm"
            variant={enabled ? "outline" : "default"}
          >
            {enabled ? "Manage" : "Turn on"}
          </Button>
        )
      }
      description="An authenticator code is required on sign-in and before sensitive changes."
      title="Two-factor authentication"
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted",
            loading && "animate-pulse"
          )}
        >
          {stateIcon}
        </span>
        <div className="flex flex-col gap-0.5">
          <span className={cn("w-fit font-medium text-sm", loading && VEILED)}>
            {enabled && !loading ? "On" : "Off"}
          </span>
          <span
            className={cn(
              "w-fit text-muted-foreground text-xs",
              loading && VEILED
            )}
          >
            {detail}
          </span>
        </div>
      </div>

      <TotpSetupDialog
        onEnrolled={onChanged}
        onOpenChange={setSetupOpen}
        open={setupOpen}
      />
      {status && (
        <TotpManageDialog
          onChanged={onChanged}
          onOpenChange={setManageOpen}
          open={manageOpen}
          status={status}
        />
      )}
    </SettingsCard>
  );
}
